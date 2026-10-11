// SIMULATED DATA. Fake traders with known skill call Bitget stock perps during real US session hours,
// replayed on real 1m candles with the live rules: house bands recalibrated daily from the prior 30 days,
// two boards, caps and gaps, copy detection, Wilson qualification, tiers, warmup and decaying points.
// Compares three ways of following the crowd, after costs. Writes data/sim.db and results/backtest.json.
//
//   npm run simulate -- [--days 21] [--seed 7]
import { rmSync, writeFileSync } from 'node:fs';
import { AGENT, BANDS, BOARDS, BOARD_IDS, CONSENSUS, PAIRS, SCORING, boardsFor, type BoardId, type Direction } from '../src/config.js';
import { costFrac, costR } from '../src/agent.js';
import { bandFromCandles, saveBand } from '../src/bands.js';
import { CallRejected, applyOutcome, checkCall, insertCall } from '../src/calls.js';
import { detectConsensus, saveSignal } from '../src/consensus.js';
import { openDb } from '../src/db.js';
import { history, lowerBound } from '../src/history.js';
import { allTickers, type Candle } from '../src/market.js';
import { levels, pnlR, resolveBracket, type Bracket } from '../src/resolve.js';
import { boardStats, leaderboard, type TraderStats } from '../src/scoring.js';
import { crossesWeekend, sessionOpen } from '../src/sessions.js';
import { rewardBoard, settleDue } from '../src/rewards.js';

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const DAYS = arg('days', 21);
let seed = arg('seed', 7);
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const M = 60_000, H = 60 * M, D = 24 * H;
const end = Math.floor(Date.now() / D) * D;
const start = end - DAYS * D;

// ---------- market data ----------
console.log(`Fetching ${DAYS} days of 1m + ${DAYS + BANDS.volWindowDays} days of 5m candles for ${PAIRS.length} stocks (cached)...`);
const m1 = new Map<string, Candle[]>(), m5 = new Map<string, Candle[]>(), spreadBps = new Map<string, number>();
const tk = await allTickers();
for (const p of PAIRS) {
  m1.set(p.symbol, await history(p.symbol, '1m', start, end));
  m5.set(p.symbol, await history(p.symbol, '5m', start - BANDS.volWindowDays * D, end));
  const t = tk.get(p.symbol)!;
  spreadBps.set(p.symbol, ((t.ask - t.bid) / t.mid) * 1e4);
  process.stdout.write(`  ${p.symbol}: ${m1.get(p.symbol)!.length} 1m candles\r`);
}
console.log();

// House bands as they would have been published each UTC day (prior 30 days only).
const bandCache = new Map<string, { bps: number; listed: boolean }>();
function bandAt(pair: string, board: BoardId, t: number) {
  const day = Math.floor(t / D) * D, key = `${pair}:${board}:${day}`;
  if (!bandCache.has(key)) {
    const { bps, windows } = bandFromCandles(m5.get(pair)!, BOARDS[board].horizonMin, day - BANDS.volWindowDays * D, day, BANDS.strideMin, board);
    bandCache.set(key, { bps, listed: Number.isFinite(bps) && windows >= 20 && bps >= BANDS.minSpreadMultiple * spreadBps.get(pair)! });
  }
  return bandCache.get(key)!;
}
/** Entry = open of the first full minute after the decision; locked_at sits just before it. */
function entryAt(pair: string, t: number) {
  const cs = m1.get(pair)!, i = lowerBound(cs, Math.floor(t / M) * M + M);
  return cs[i] && cs[i].ts - t < 5 * M ? { entry: cs[i].o, locked_at: cs[i].ts - 1 } : null;
}
const outcome = (pair: string, b: Bracket) => {
  const cs = m1.get(pair)!;
  return resolveBracket(b, cs.slice(lowerBound(cs, b.locked_at - M), lowerBound(cs, b.expires_at) + 1), Infinity)!;
};

// ---------- simulated traders ----------
// edge = chance the trader "knows" which side hits first (a stand-in for skill); negative = reliably wrong.
const TIERS = [
  { tier: 'sharp', n: 3, edge: 0.35, rate: 4 },
  { tier: 'good', n: 5, edge: 0.2, rate: 4 },
  { tier: 'average', n: 8, edge: 0.06, rate: 4 },
  { tier: 'noise', n: 8, edge: 0, rate: 5 },
  { tier: 'fader', n: 2, edge: -0.2, rate: 4 },
  { tier: 'clone', n: 2, edge: NaN, rate: 0 },   // copies sharp #1 a few minutes later
];
rmSync('data/sim.db', { force: true }); rmSync('data/sim.db-wal', { force: true }); rmSync('data/sim.db-shm', { force: true });
const db = openDb('data/sim.db');
type Sim = { id: number; tier: string; edge: number; rate: number; swingShare: number; longShare: number };
const traders: Sim[] = [];
const names = Array.from({ length: TIERS.reduce((a, t) => a + t.n, 0) }, (_, i) => i).sort(() => rand() - 0.5);
let k = 0;
for (const t of TIERS) for (let i = 0; i < t.n; i++) {
  const r = db.prepare('INSERT INTO traders (name, simulated, sim_skill, created_at) VALUES (?, 1, ?, ?)')
    .run(`sim_trader_${String(names[k++] + 1).padStart(2, '0')}`, t.tier, start);
  traders.push({ id: Number(r.lastInsertRowid), tier: t.tier, edge: t.edge, rate: t.rate, swingShare: 0.3 + rand() * 0.4, longShare: 0.15 + rand() * 0.3 });
}

// Calls cluster around "moments" on each stock (a move, a headline) during the session, plus background calls.
type Intent = { t: number; trader: Sim; pair: string; board: BoardId; copyOf?: number };
const intents: Intent[] = [];
const active = traders.filter((t) => t.tier !== 'clone');
// Liquid names go to HT/LT; long-term names to D1 (mostly) or D2.
const boardFor = (tr: Sim, pair: string): BoardId => {
  const [a, b] = boardsFor(pair);
  return a === 'intraday' ? (rand() < tr.swingShare ? b : a) : rand() < 0.7 ? a : b;
};
const liquidPairs = PAIRS.filter((p) => p.group === 'liquid'), longPairs = PAIRS.filter((p) => p.group === 'long');
for (const p of PAIRS) for (let t = start; t < end; t += -Math.log(rand()) * (p.group === 'liquid' ? D / 3 : D / 1.5)) {
  if (!sessionOpen(t, 'us')) continue;
  const [a, b] = boardsFor(p.symbol);
  const board = rand() < 0.5 ? a : b;
  for (const tr of active) if (rand() < 0.22) intents.push({ t: t + rand() * (p.group === 'liquid' ? 10 : 60) * M, trader: tr, pair: p.symbol, board });
}
for (const tr of active) for (let i = 0; i < tr.rate * DAYS; i++) {
  const t = start + rand() * DAYS * D;
  if (!sessionOpen(t, 'us')) continue;
  const pair = pick(rand() < tr.longShare ? longPairs : liquidPairs).symbol;
  intents.push({ t, trader: tr, pair, board: boardFor(tr, pair) });
}
intents.sort((a, b) => a.t - b.t);
const queue: Intent[] = [...intents];
let cursor = 0;
function enqueue(x: Intent) {
  let lo = cursor + 1, hi = queue.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (queue[m].t <= x.t) lo = m + 1; else hi = m; }
  queue.splice(lo, 0, x);
}

// Stats only change when calls resolve; cache per board per 15 minutes, always as of the bucket start (no look-ahead).
const statsCache = new Map<string, Map<number, TraderStats>>();
function statsAt(board: BoardId, t: number) {
  const b = Math.floor(t / (15 * M)) * 15 * M, key = `${board}:${b}`;
  if (!statsCache.has(key)) statsCache.set(key, boardStats(db, board, b));
  return statsCache.get(key)!;
}

// ---------- replay ----------
type Trade = { strategy: string; board: BoardId; pair: string; t: number; r: number; status: string };
const trades: Trade[] = [];
const agentOpen: { pair: string; until: number }[] = [];
const rejects = new Map<string, number>();
const sharp1 = traders.find((t) => t.tier === 'sharp')!;
const clones = traders.filter((t) => t.tier === 'clone');
const cost = (pair: string, entry: number) => costFrac(entry, (spreadBps.get(pair)! / 1e4) * entry);

function tryCall(it: Intent, forced?: Direction) {
  const e = entryAt(it.pair, it.t);
  if (!e) return void rejects.set('no price', (rejects.get('no price') ?? 0) + 1);
  const band = bandAt(it.pair, it.board, e.locked_at);
  try {
    checkCall(db, { traderId: it.trader.id, pair: it.pair, board: it.board, now: e.locked_at, mode: 'us',
      band: { pair: it.pair, board: it.board, bps: band.bps, spread_bps: 0, windows: 0, listed: band.listed ? 1 : 0, computed_at: 0 } });
  } catch (err) {
    if (!(err instanceof CallRejected)) throw err;
    const why = err.message.replace(/\d+/g, '#').slice(0, 40);
    return void rejects.set(why, (rejects.get(why) ?? 0) + 1);
  }
  const horizon = BOARDS[it.board].horizonMin * M;
  if (e.locked_at + horizon >= end) return;
  let direction: Direction = forced ?? (rand() < 0.5 ? 'long' : 'short');
  if (!forced && rand() < Math.abs(it.trader.edge)) {
    const base = { entry: e.entry, distance: (e.entry * band.bps) / 1e4, locked_at: e.locked_at, expires_at: e.locked_at + horizon };
    const lw = outcome(it.pair, { ...base, direction: 'long' }).status;
    const sw = outcome(it.pair, { ...base, direction: 'short' }).status;
    const good: Direction | null = lw === 'win' ? 'long' : sw === 'win' ? 'short' : null;
    if (good) direction = it.trader.edge > 0 ? good : good === 'long' ? 'short' : 'long';
  }
  const call = insertCall(db, { traderId: it.trader.id, pair: it.pair, board: it.board, direction, bandBps: band.bps, entry: e.entry, lockedAt: e.locked_at, simulated: true });
  const o = outcome(it.pair, call);
  applyOutcome(db, call.id, o);
  const c = cost(it.pair, e.entry);

  // Baseline A: follow every call. Baseline B: follow every call from a trader holding a tier at lock time.
  trades.push({ strategy: 'everyone', board: it.board, pair: it.pair, t: o.at, r: pnlR(call, o, c), status: o.status });
  const s = statsAt(it.board, e.locked_at).get(it.trader.id);
  if (s?.tier) trades.push({ strategy: 'tiered', board: it.board, pair: it.pair, t: o.at, r: pnlR(call, o, c), status: o.status });

  if (it.trader.id === sharp1.id) for (const cl of clones) enqueue({ t: e.locked_at + (1 + rand() * 4) * M, trader: cl, pair: it.pair, board: it.board, copyOf: call.id });

  // Consensus agent: same detector and gates as live.
  const sig = detectConsensus(db, it.pair, it.board, e.locked_at, band.bps);
  if (!sig) return;
  const saved = saveSignal(db, sig, true);
  const se = entryAt(it.pair, e.locked_at + 1);
  if (!se) return;
  const now = se.locked_at;
  const open = agentOpen.filter((a) => a.until > now);
  const todayR = trades.filter((x) => x.strategy === 'consensus' && x.t >= Math.floor(now / D) * D && x.t <= now).reduce((a, x) => a + x.r, 0);
  const cr = costR(band.bps, spreadBps.get(it.pair)!);
  const block = cr > AGENT.maxCostR ? `costs > ${AGENT.maxCostR}R` : crossesWeekend(now + horizon) ? 'weekend'
    : open.length >= AGENT.maxOpen ? 'max open' : open.some((a) => a.pair === it.pair) ? 'pair busy' : todayR <= -AGENT.dailyLossLimitR ? 'daily loss' : null;
  const b: Bracket = { direction: sig.direction, entry: se.entry, distance: (se.entry * band.bps) / 1e4, locked_at: se.locked_at, expires_at: se.locked_at + horizon };
  const { target, stop } = levels(b);
  if (block) {
    db.prepare(`INSERT INTO agent_trades (signal_id, board, pair, direction, entry, target, stop, distance, qty, horizon_min, created_at, expires_at, status, mode, risk_note, simulated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'blocked', 'sim', ?, 1)`).run(saved.id!, it.board, it.pair, sig.direction, se.entry, target, stop, b.distance, BOARDS[it.board].horizonMin, now, b.expires_at, block);
    return;
  }
  const ao = outcome(it.pair, b);
  const r = pnlR(b, ao, cost(it.pair, se.entry));
  agentOpen.push({ pair: it.pair, until: ao.at });
  trades.push({ strategy: 'consensus', board: it.board, pair: it.pair, t: ao.at, r, status: ao.status });
  db.prepare(`INSERT INTO agent_trades (signal_id, board, pair, direction, entry, target, stop, distance, qty, horizon_min, created_at, opened_at, expires_at,
    status, mode, reason, exit_price, pnl_r, resolved_at, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sim', ?, ?, ?, ?, 1)`).run(
    saved.id!, it.board, it.pair, sig.direction, se.entry, target, stop, b.distance, Number((AGENT.riskUsdt / b.distance).toPrecision(4)),
    BOARDS[it.board].horizonMin, now, now, b.expires_at, ao.status, `${sig.n_traders} qualified traders, ${(sig.agreement * 100).toFixed(0)}% of weight`, ao.exit, r, ao.at);
}

console.log(`Replaying ${intents.length} call intents, ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}...`);
for (; cursor < queue.length; cursor++) {
  const it = queue[cursor];
  if (cursor % 500 === 0) process.stdout.write(`  ${cursor}/${queue.length}\r`);
  if (it.copyOf) tryCall(it, (db.prepare('SELECT direction FROM calls WHERE id = ?').get(it.copyOf) as { direction: Direction }).direction);
  else tryCall(it);
}
console.log();

// Publish the last day's bands into the sim DB for the dashboard.
for (const p of PAIRS) for (const b of boardsFor(p.symbol)) {
  const x = bandAt(p.symbol, b, end - 1);
  saveBand(db, { pair: p.symbol, board: b, bps: x.bps, spread_bps: spreadBps.get(p.symbol)!, windows: 0, listed: x.listed ? 1 : 0, computed_at: end });
}
const lastPx = (pair: string) => m1.get(pair)!.at(-1)!.c;
for (const p of PAIRS) db.prepare('INSERT OR REPLACE INTO quotes (pair, price, bid, ask, updated_at) VALUES (?, ?, ?, ?, ?)').run(p.symbol, lastPx(p.symbol), lastPx(p.symbol), lastPx(p.symbol), end);

// Daily 65% club, settled exactly as live.
const rewardRows = settleDue(db, end + D, 'us');
const daysSettled = new Set(rewardRows.map((r) => r.day)).size;
const rewardsBySkill = new Map<string, { traderDays: number; qualified: number; points: number }>();
for (const r of rewardRows) {
  const sk = traders.find((t) => t.id === r.trader_id)!.tier;
  const x = rewardsBySkill.get(sk) ?? { traderDays: 0, qualified: 0, points: 0 };
  x.traderDays++; x.qualified += r.eligible; x.points += r.points;
  rewardsBySkill.set(sk, x);
}
const rewards = {
  daysSettled,
  bySkill: Object.fromEntries([...rewardsBySkill].map(([k, v]) => [k, { ...v, qualifyRate: +(v.qualified / v.traderDays).toFixed(3), points: Math.round(v.points) }])),
  board: rewardBoard(db, end + D).slice(0, 15).map((r) => ({ ...r, skill: traders.find((t) => t.id === r.trader_id)!.tier })),
};

// ---------- results ----------
const summarize = (name: string, board?: BoardId) => {
  const xs = trades.filter((x) => x.strategy === name && (!board || x.board === board)).sort((a, b) => a.t - b.t);
  let eq = 0, peak = 0, dd = 0;
  const curve = xs.map((x) => { eq += x.r; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); return { t: x.t, r: +eq.toFixed(4) }; });
  const w = xs.filter((x) => x.status === 'win').length, l = xs.filter((x) => x.status === 'loss').length;
  return {
    strategy: name, board: board ?? 'all', trades: xs.length, wins: w, losses: l, washes: xs.length - w - l,
    hitRate: w + l ? w / (w + l) : null, totalR: +eq.toFixed(2), avgR: xs.length ? +(eq / xs.length).toFixed(3) : null, maxDrawdownR: +dd.toFixed(2), curve,
  };
};
const strategies = ['consensus', 'tiered', 'everyone'].map((s) => summarize(s));
const byBoard = BOARD_IDS.flatMap((b) => ['consensus', 'tiered', 'everyone'].map((s) => { const { curve, ...x } = summarize(s, b); return x; }));
const tierOf = new Map(traders.map((t) => [t.id, t.tier]));
const boards = Object.fromEntries(BOARD_IDS.map((b) => [b, leaderboard(db, b, end).map((s, i) => ({
  rank: i + 1, name: s.name, skill: tierOf.get(s.trader_id), status: s.status, wins: s.wins, losses: s.losses, washes: s.washes,
  hitRate: s.hitRate, shrunk: +s.shrunk.toFixed(3), lb: +s.lb.toFixed(3), points: +s.points.toFixed(2), copier: s.copier,
}))]));
const nCalls = (db.prepare('SELECT COUNT(*) AS n FROM calls').get() as { n: number }).n;
const nSignals = (db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n;
const blocked = db.prepare("SELECT risk_note, COUNT(*) AS n FROM agent_trades WHERE status = 'blocked' GROUP BY risk_note").all();

writeFileSync('results/backtest.json', JSON.stringify({
  simulated: true,
  note: 'Fake traders with assigned skill, calling Bitget stock perps during US session hours, replayed on real 1m candles. '
    + 'Costs: 2x taker fee + current spread. Ambiguous candles count as full losses for strategies.',
  period: { start, end, days: DAYS }, seed: arg('seed', 7),
  params: { BOARDS, BANDS, SCORING, CONSENSUS, AGENT: { maxOpen: AGENT.maxOpen, dailyLossLimitR: AGENT.dailyLossLimitR, maxCostR: AGENT.maxCostR } },
  calls: nCalls, signals: nSignals, blocked, rewards, rejects: Object.fromEntries(rejects), strategies, byBoard, boards,
}, null, 2));

console.log(`\nSIMULATED replay: ${traders.length} traders, ${nCalls} calls, ${nSignals} consensus signals`);
console.table(byBoard.map((s) => ({ ...s, hitRate: s.hitRate === null ? '-' : (s.hitRate * 100).toFixed(1) + '%' })));
for (const b of BOARD_IDS) {
  console.log(`\n${BOARDS[b].title} leaderboard (top 12)`);
  console.table(boards[b].slice(0, 12).map((r) => ({ ...r, hitRate: Number.isFinite(r.hitRate) ? (r.hitRate * 100).toFixed(0) + '%' : '-' })));
}
console.log(`\n65% club over ${daysSettled} trading days, by true skill:`);
console.table(rewards.bySkill);
console.table(rewards.board.slice(0, 10).map(({ trader_id, ...r }) => r));
console.log('Agent blocked:', blocked, '\nRejected intents:', Object.fromEntries(rejects));
