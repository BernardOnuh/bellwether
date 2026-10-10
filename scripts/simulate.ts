// SIMULATED DATA. Generates fake traders with known skill, replays them on real Bitget 1m history,
// and compares three ways of following the crowd, after costs. Writes data/sim.db and results/backtest.json.
//
//   npm run simulate -- [--days 7] [--warmup 7] [--seed 42]
import { rmSync, writeFileSync } from 'node:fs';
import { AGENT, CONSENSUS, PAIRS, RULES, type Direction } from '../src/config.js';
import { costFrac } from '../src/agent.js';
import { detectConsensus, saveSignal } from '../src/consensus.js';
import { insertCall, applyOutcome } from '../src/calls.js';
import { openDb } from '../src/db.js';
import { history1m, lowerBound } from '../src/history.js';
import { ticker, type Candle } from '../src/market.js';
import { profileFrom1m, saveProfile, type PairProfile } from '../src/profile.js';
import { levels, pnlR, resolveBracket, type Bracket, type Outcome } from '../src/resolve.js';
import { allStats, leaderboard } from '../src/scoring.js';

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const DAYS = arg('days', 7), WARMUP = arg('warmup', 7);
let seed = arg('seed', 42);
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const M = 60_000, H = 60 * M, D = 24 * H;
const end = Math.floor(Date.now() / H) * H - H;
const replayStart = end - DAYS * D;
const histStart = replayStart - WARMUP * D;

// ---------- market data ----------
console.log(`Fetching ${WARMUP + DAYS} days of 1m candles for ${PAIRS.length} pairs (cached after first run)...`);
const hist = new Map<string, Candle[]>();
const spreadFrac = new Map<string, number>();
for (const p of PAIRS) {
  hist.set(p.symbol, await history1m(p.symbol, histStart, end));
  const t = await ticker(p.symbol);
  spreadFrac.set(p.symbol, (t.ask - t.bid) / t.mid);
}
for (const [s, cs] of hist) console.log(`  ${s}: ${cs.length} candles`);

const profCache = new Map<string, PairProfile | null>();
function profileAt(pair: string, t: number) {
  const bucket = Math.floor(t / (30 * M)) * 30 * M;  // refresh every 30 min like the live service
  const key = `${pair}:${bucket}`;
  if (!profCache.has(key)) {
    const cs = hist.get(pair)!;
    const window = cs.slice(lowerBound(cs, bucket - 7 * D), lowerBound(cs, bucket));
    const last = window[window.length - 1];
    profCache.set(key, last ? profileFrom1m(pair, window, bucket, spreadFrac.get(pair)! * last.c) : null);
  }
  return profCache.get(key)!;
}
/** Entry = open of the first full minute after the decision; locked_at sits just before it. */
function entryAt(pair: string, t: number) {
  const cs = hist.get(pair)!;
  const i = lowerBound(cs, Math.floor(t / M) * M + M);
  return cs[i] ? { entry: cs[i].o, locked_at: cs[i].ts - 1 } : null;
}
const outcome = (pair: string, b: Bracket) => {
  const cs = hist.get(pair)!;
  return resolveBracket(b, cs.slice(lowerBound(cs, b.locked_at - M), lowerBound(cs, b.expires_at) + 1), Infinity)!;
};

// ---------- simulated traders ----------
// edge = chance the trader "knows" which side hits first (a stand-in for skill); negative = reliably wrong.
const TIERS = [
  { tier: 'sharp', n: 3, edge: 0.3, rate: 7, band: [0.6, 1.1] },
  { tier: 'good', n: 5, edge: 0.15, rate: 6, band: [0.6, 1.2] },
  { tier: 'average', n: 8, edge: 0.05, rate: 6, band: [0.5, 1.3] },
  { tier: 'noise', n: 8, edge: 0, rate: 8, band: [0.5, 1.5] },
  { tier: 'fader', n: 2, edge: -0.15, rate: 6, band: [0.5, 1.2] },
  { tier: 'washer', n: 2, edge: 0, rate: 6, band: [1.45, 1.5] },
  { tier: 'clone', n: 2, edge: NaN, rate: 0, band: [0.6, 1.1] },   // copies sharp #1
];

rmSync('data/sim.db', { force: true }); rmSync('data/sim.db-wal', { force: true }); rmSync('data/sim.db-shm', { force: true });
const db = openDb('data/sim.db');
type Sim = { id: number; tier: string; edge: number; rate: number; band: number[] };
const traders: Sim[] = [];
const order = Array.from({ length: TIERS.reduce((a, t) => a + t.n, 0) }, (_, i) => i).sort(() => rand() - 0.5);
let k = 0;
for (const t of TIERS) for (let i = 0; i < t.n; i++) {
  const name = `sim_trader_${String(order[k++] + 1).padStart(2, '0')}`;
  const r = db.prepare('INSERT INTO traders (name, simulated, sim_skill, created_at) VALUES (?, 1, ?, ?)').run(name, t.tier, replayStart);
  traders.push({ id: Number(r.lastInsertRowid), tier: t.tier, edge: t.edge, rate: t.rate, band: t.band });
}

// Calls cluster around "moments" on each pair (a move, a headline) so traders sometimes overlap, plus background calls.
type Intent = { t: number; trader: Sim; pair: string; copyOf?: number };
const intents: Intent[] = [];
const active = traders.filter((t) => t.tier !== 'clone');
for (const p of PAIRS) {
  for (let t = replayStart; t < end; t += -Math.log(rand()) * (D / 8)) {
    for (const tr of active) if (rand() < tr.rate / 8 / PAIRS.length * 3) intents.push({ t: t + rand() * 8 * M, trader: tr, pair: p.symbol });
  }
}
for (const tr of active) for (let i = 0; i < tr.rate * DAYS * 0.4; i++) intents.push({ t: replayStart + rand() * DAYS * D, trader: tr, pair: pick(PAIRS).symbol });
intents.sort((a, b) => a.t - b.t);

// ---------- replay ----------
const sharp1 = traders.find((t) => t.tier === 'sharp')!;
const clones = traders.filter((t) => t.tier === 'clone');
const queue: Intent[] = [...intents];
let cursor = 0;
/** Insert a future intent (clone copies) keeping the queue time-ordered. */
function enqueue(x: Intent) {
  let lo = cursor + 1, hi = queue.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (queue[m].t <= x.t) lo = m + 1; else hi = m; }
  queue.splice(lo, 0, x);
}
let rejected = 0;

type Trade = { strategy: string; pair: string; t: number; r: number; status: string };
const trades: Trade[] = [];
const agentOpen: { pair: string; until: number }[] = [];

function tryCall(it: Intent, forced?: { direction: Direction; distance: number }) {
  const prof = profileAt(it.pair, it.t);
  const e = entryAt(it.pair, it.t);
  if (!prof || !e || e.locked_at >= end - prof.window_min * M || prof.closed || prof.band_lo > prof.band_hi) return void rejected++;
  // Same rules as live: one open call per pair, daily cap.
  const busy = db.prepare("SELECT 1 FROM calls WHERE trader_id = ? AND pair = ? AND (resolved_at IS NULL OR resolved_at > ?)").get(it.trader.id, it.pair, e.locked_at);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM calls WHERE trader_id = ? AND locked_at >= ?').get(it.trader.id, Math.floor(e.locked_at / D) * D) as { n: number };
  if (busy || n >= RULES.dailyCap) return void rejected++;

  let distance = forced?.distance ?? Math.min(prof.band_hi, Math.max(prof.band_lo, (it.trader.band[0] + rand() * (it.trader.band[1] - it.trader.band[0])) * prof.typical_range));
  let direction: Direction = forced?.direction ?? (rand() < 0.5 ? 'long' : 'short');
  const base = { entry: e.entry, distance, locked_at: e.locked_at, expires_at: e.locked_at + prof.window_min * M };
  if (!forced && rand() < Math.abs(it.trader.edge)) {
    const longWins = outcome(it.pair, { ...base, direction: 'long' }).status;
    const shortWins = outcome(it.pair, { ...base, direction: 'short' }).status;
    const good: Direction | null = longWins === 'win' ? 'long' : shortWins === 'win' ? 'short' : null;
    if (good) direction = it.trader.edge > 0 ? good : good === 'long' ? 'short' : 'long';
  }
  distance = Number(distance.toPrecision(4));
  if (distance < prof.band_lo || distance > prof.band_hi) distance = prof.band_lo;
  const call = insertCall(db, { traderId: it.trader.id, pair: it.pair, direction, distance, entry: e.entry, lockedAt: e.locked_at, profile: prof, simulated: true });
  const o = outcome(it.pair, call);
  applyOutcome(db, call.id, o);

  const cost = costFrac(e.entry, spreadFrac.get(it.pair)! * e.entry);
  // Baseline A: follow every call.
  trades.push({ strategy: 'everyone', pair: it.pair, t: o.at, r: pnlR(call, o, cost), status: o.status });
  // Baseline B: follow every call from a currently top-5 qualified trader, individually.
  const top = leaderboard(db, e.locked_at).filter((s) => s.qualified).slice(0, 5).map((s) => s.trader_id);
  if (top.includes(it.trader.id)) trades.push({ strategy: 'top5', pair: it.pair, t: o.at, r: pnlR(call, o, cost), status: o.status });

  if (it.trader.id === sharp1.id) for (const c of clones) enqueue({ t: e.locked_at + (1 + rand() * 3) * M, trader: c, pair: it.pair, copyOf: call.id });

  // Consensus agent.
  const s = detectConsensus(db, prof, e.locked_at);
  if (!s) return;
  const saved = saveSignal(db, s, true);
  const se = entryAt(it.pair, e.locked_at + 1);
  if (!se) return;
  const now = se.locked_at;
  const open = agentOpen.filter((a) => a.until > now);
  const todayR = trades.filter((x) => x.strategy === 'consensus' && x.t >= Math.floor(now / D) * D && x.t <= now).reduce((a, x) => a + x.r, 0);
  const block = open.length >= AGENT.maxOpen ? 'max open' : open.some((a) => a.pair === it.pair) ? 'pair busy' : todayR <= -AGENT.dailyLossLimitR ? 'daily loss' : null;
  const b: Bracket = { direction: s.direction, entry: se.entry, distance: s.distance, locked_at: se.locked_at, expires_at: se.locked_at + s.window_min * M };
  const { target, stop } = levels(b);
  if (block) {
    db.prepare(`INSERT INTO agent_trades (signal_id, pair, direction, entry, target, stop, distance, qty, window_min, created_at, expires_at, status, mode, risk_note, simulated)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'blocked', 'sim', ?, 1)`).run(saved.id!, s.pair, s.direction, se.entry, target, stop, s.distance, s.window_min, now, b.expires_at, block);
    return;
  }
  const ao: Outcome = outcome(it.pair, b);
  const r = pnlR(b, ao, costFrac(se.entry, spreadFrac.get(it.pair)! * se.entry));
  agentOpen.push({ pair: it.pair, until: ao.at });
  trades.push({ strategy: 'consensus', pair: it.pair, t: ao.at, r, status: ao.status });
  db.prepare(`INSERT INTO agent_trades (signal_id, pair, direction, entry, target, stop, distance, qty, window_min, created_at, opened_at, expires_at,
    status, mode, reason, exit_price, pnl_r, resolved_at, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sim', ?, ?, ?, ?, 1)`).run(
    saved.id!, s.pair, s.direction, se.entry, target, stop, s.distance, Number((AGENT.riskUsdt / s.distance).toPrecision(4)), s.window_min, now, now, b.expires_at,
    ao.status, `${s.n_traders} qualified traders, ${(s.agreement * 100).toFixed(0)}% agreement`, ao.exit, r, ao.at);
}

console.log(`Replaying ${intents.length} call intents from ${new Date(replayStart).toISOString()} to ${new Date(end).toISOString()}...`);
for (; cursor < queue.length; cursor++) {
  const it = queue[cursor];
  if (cursor % 500 === 0) process.stdout.write(`  ${cursor}/${queue.length}\r`);
  if (it.copyOf) {
    const src = db.prepare('SELECT direction, distance FROM calls WHERE id = ?').get(it.copyOf) as { direction: Direction; distance: number };
    tryCall(it, src);
  } else tryCall(it);
}

for (const p of PAIRS) { const pr = profileAt(p.symbol, end - 1); if (pr) saveProfile(db, pr); }

// ---------- results ----------
const summarize = (name: string) => {
  const xs = trades.filter((x) => x.strategy === name).sort((a, b) => a.t - b.t);
  let eq = 0, peak = 0, dd = 0;
  const curve = xs.map((x) => { eq += x.r; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); return { t: x.t, r: +eq.toFixed(4) }; });
  const w = xs.filter((x) => x.status === 'win').length, l = xs.filter((x) => x.status === 'loss').length;
  return {
    strategy: name, trades: xs.length, wins: w, losses: l, washes: xs.length - w - l,
    hitRate: w + l ? w / (w + l) : null, totalR: +eq.toFixed(2), avgR: xs.length ? +(eq / xs.length).toFixed(3) : null, maxDrawdownR: +dd.toFixed(2), curve,
  };
};
const strategies = ['consensus', 'top5', 'everyone'].map(summarize);
const finalStats = [...allStats(db).values()];
const tierOf = new Map(traders.map((t) => [t.id, t.tier]));
const board = leaderboard(db).map((s, i) => ({ rank: s.qualified ? i + 1 : null, name: s.name, tier: tierOf.get(s.trader_id), wins: s.wins, losses: s.losses, washes: s.washes,
  hitRate: s.hitRate, shrunk: +s.shrunk.toFixed(3), washRate: +s.washRate.toFixed(3), rankScore: +s.rankScore.toFixed(3), qualified: s.qualified }));
const signals = db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number };
const blocked = db.prepare("SELECT risk_note, COUNT(*) AS n FROM agent_trades WHERE status = 'blocked' GROUP BY risk_note").all();

writeFileSync('results/backtest.json', JSON.stringify({
  simulated: true,
  note: 'Fake traders with assigned skill replayed on real Bitget USDT-perp 1m candles. Costs: 2x taker fee + live spread. Ambiguous candles count as full losses for strategies.',
  period: { start: replayStart, end, warmupDays: WARMUP, days: DAYS }, seed: arg('seed', 42),
  params: { RULES, CONSENSUS, AGENT: { maxOpen: AGENT.maxOpen, dailyLossLimitR: AGENT.dailyLossLimitR } },
  calls: finalStats.reduce((a, s) => a + s.calls, 0), rejectedIntents: rejected, signals: signals.n, blocked,
  strategies, leaderboard: board,
}, null, 2));

console.log(`\nSIMULATED replay: ${board.length} traders, ${finalStats.reduce((a, s) => a + s.calls, 0)} calls, ${signals.n} consensus signals`);
console.table(strategies.map(({ curve, ...s }) => ({ ...s, hitRate: s.hitRate === null ? '-' : (s.hitRate * 100).toFixed(1) + '%' })));
console.table(board.slice(0, 12));
console.log('Blocked by risk gate:', blocked);
console.log('Wrote results/backtest.json and data/sim.db');
