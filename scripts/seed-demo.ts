// Seeds 10 DEMO players into the live database with ~2 weeks of history, so the leaderboard isn't empty at launch.
// Every demo player is flagged (traders.simulated = 1, sim_skill = 'demo:<scenario>') and tagged DEMO everywhere.
// Their calls follow the live rules (session hours, caps, gaps, bands) and are graded on REAL Bitget 1m candles;
// only their "skill" is simulated (with probability `edge` they pick the side that hits first).
//
//   npm run seed:demo            add the demo players (replaces any previous demo players)
//   npm run seed:demo -- --remove   remove every demo player, their calls and rewards
import { BANDS, BOARDS, PAIRS, boardsFor, type BoardId, type Direction } from '../src/config.js';
import { bandFromCandles } from '../src/bands.js';
import { CallRejected, applyOutcome, checkCall, insertCall, type CallRow } from '../src/calls.js';
import { openDb, setSetting } from '../src/db.js';
import { history, lowerBound } from '../src/history.js';
import type { Candle } from '../src/market.js';
import { resolveBracket, type Bracket } from '../src/resolve.js';
import { ensureRewardsTable, settleDue } from '../src/rewards.js';
import { sessionOpen } from '../src/sessions.js';

const M = 60_000, D = 86_400_000;
const db = openDb();
ensureRewardsTable(db);

function removeDemo() {
  const ids = (db.prepare("SELECT id FROM traders WHERE sim_skill LIKE 'demo:%'").all() as { id: number }[]).map((r) => r.id);
  if (!ids.length) return 0;
  const list = ids.join(',');
  db.exec(`DELETE FROM daily_rewards WHERE trader_id IN (${list}); DELETE FROM calls WHERE trader_id IN (${list}); DELETE FROM traders WHERE id IN (${list});`);
  // Rewards are re-settled from scratch so the remaining (real) players' days are recomputed without the demo players.
  db.exec('DELETE FROM daily_rewards'); db.prepare("DELETE FROM settings WHERE key = 'rewards_next_day'").run();
  settleDue(db, Date.now());
  return ids.length;
}

const removed = removeDemo();
if (process.argv.includes('--remove')) { console.log(`Removed ${removed} demo players.`); process.exit(0); }

// The cached replay window (same files scripts/simulate.ts uses): 21 days of 1m candles ending at today's UTC midnight.
const end = Math.floor(Date.now() / D) * D;
const start = end - 21 * D;
const m1 = new Map<string, Candle[]>(), m5 = new Map<string, Candle[]>();
for (const p of PAIRS) {
  m1.set(p.symbol, await history(p.symbol, '1m', start, end));
  m5.set(p.symbol, await history(p.symbol, '5m', start - BANDS.volWindowDays * D, end));
}
const bandCache = new Map<string, { bps: number; listed: boolean }>();
function bandAt(pair: string, board: BoardId, t: number) {
  const day = Math.floor(t / D) * D, key = `${pair}:${board}:${day}`;
  if (!bandCache.has(key)) {
    const { bps, windows } = bandFromCandles(m5.get(pair)!, BOARDS[board].horizonMin, day - BANDS.volWindowDays * D, day, BANDS.strideMin, board);
    bandCache.set(key, { bps, listed: Number.isFinite(bps) && windows >= 20 });
  }
  return bandCache.get(key)!;
}
const entryAt = (pair: string, t: number) => { const cs = m1.get(pair)!, i = lowerBound(cs, Math.floor(t / M) * M + M); return cs[i] && cs[i].ts - t < 5 * M ? { entry: cs[i].o, locked_at: cs[i].ts - 1 } : null; };
const outcome = (pair: string, b: Bracket) => { const cs = m1.get(pair)!; return resolveBracket(b, cs.slice(lowerBound(cs, b.locked_at - M), lowerBound(cs, b.expires_at) + 1), Infinity)!; };

let seed = 20261011;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

interface Persona {
  name: string; scenario: string; kind?: 'agent'; days: number; perDay: number;
  boards: BoardId[]; edge: (dayIdx: number, totalDays: number) => number; favorites?: string[]; copies?: string;
}
const LIQ = PAIRS.filter((p) => p.group === 'liquid').map((p) => p.symbol), LONG = PAIRS.filter((p) => p.group === 'long').map((p) => p.symbol);
const PERSONAS: Persona[] = [
  { name: 'Maya Chen', scenario: 'wolf-veteran', days: 20, perDay: 7, boards: ['intraday', 'swing'], edge: () => 0.58, favorites: ['NVDAUSDT', 'AMDUSDT', 'MUUSDT', 'AVGOUSDT'] },
  { name: 'quant_koji', scenario: 'sharp-swing', days: 20, perDay: 3, boards: ['swing'], edge: () => 0.5 },
  { name: 'Dami O.', scenario: 'base-scalper', days: 19, perDay: 9, boards: ['intraday'], edge: () => 0.3, favorites: ['TSLAUSDT', 'MSTRUSDT', 'COINUSDT', 'PLTRUSDT'] },
  { name: 'Lena Park', scenario: 'long-term-specialist', days: 20, perDay: 3, boards: ['d1', 'd2'], edge: () => 0.5 },
  { name: 'rookie_rafa', scenario: 'warmup-newcomer', days: 4, perDay: 6, boards: ['intraday', 'swing'], edge: () => 0.35 },
  { name: 'Tom B.', scenario: 'coin-flipper', days: 18, perDay: 6, boards: ['intraday', 'swing'], edge: () => 0 },
  { name: 'sarah_trades', scenario: 'struggling', days: 17, perDay: 6, boards: ['intraday', 'swing'], edge: () => -0.2 },
  { name: 'echo_ace', scenario: 'copier', days: 18, perDay: 0, boards: ['intraday', 'swing'], edge: () => 0, copies: 'Maya Chen' },
  { name: '🤖 delta_bot', scenario: 'momentum-agent', kind: 'agent', days: 16, perDay: 8, boards: ['intraday', 'swing'], edge: () => 0.28 },
  { name: 'Nico V.', scenario: 'comeback', days: 20, perDay: 6, boards: ['intraday', 'swing'], edge: (d, n) => (d < n / 2 ? -0.15 : 0.55) },
];

const ids = new Map<string, number>();
for (const p of PERSONAS) {
  const r = db.prepare(`INSERT INTO traders (name, kind, simulated, sim_skill, created_at, onboarded_at) VALUES (?, ?, 1, ?, ?, ?)`)
    .run(p.name, p.kind ?? 'human', `demo:${p.scenario}`, end - p.days * D, end - p.days * D);
  ids.set(p.name, Number(r.lastInsertRowid));
}

// Build intents: random session times on each persona's trading days.
type Intent = { t: number; who: Persona; pair: string; board: BoardId; dayIdx: number; copyOf?: number };
const intents: Intent[] = [];
for (const p of PERSONAS) {
  if (p.copies) continue;
  for (let d = p.days; d >= 1; d--) {
    const dayStart = end - d * D;
    for (let k = 0; k < p.perDay * (0.7 + rand() * 0.6); k++) {
      let t = 0;
      for (let tries = 0; tries < 50 && !t; tries++) { const c = dayStart + 13 * 3600_000 + rand() * 7 * 3600_000; if (sessionOpen(c, 'us')) t = c; }
      if (!t) continue;
      const board = pick(p.boards);
      const pool = BOARDS[board].group === 'long' ? LONG : p.favorites && rand() < 0.7 ? p.favorites : LIQ;
      intents.push({ t, who: p, pair: pick(pool), board, dayIdx: p.days - d });
    }
  }
}
intents.sort((a, b) => a.t - b.t);

let accepted = 0, rejected = 0;
const copier = PERSONAS.find((p) => p.copies)!;
const queue = [...intents];
for (let i = 0; i < queue.length; i++) {
  const it = queue[i];
  const e = entryAt(it.pair, it.t);
  if (!e || !boardsFor(it.pair).includes(it.board)) { rejected++; continue; }
  const band = bandAt(it.pair, it.board, e.locked_at);
  const traderId = ids.get(it.who.name)!;
  try {
    checkCall(db, { traderId, pair: it.pair, board: it.board, now: e.locked_at, mode: 'us',
      band: { pair: it.pair, board: it.board, bps: band.bps, spread_bps: 0, windows: 0, listed: band.listed ? 1 : 0, computed_at: 0 } });
  } catch (err) { if (err instanceof CallRejected) { rejected++; continue; } throw err; }
  const horizon = BOARDS[it.board].horizonMin * M;
  if (e.locked_at + horizon > end) { rejected++; continue; }
  let direction: Direction;
  if (it.copyOf) direction = (db.prepare('SELECT direction FROM calls WHERE id = ?').get(it.copyOf) as { direction: Direction }).direction;
  else {
    direction = rand() < 0.5 ? 'long' : 'short';
    const edge = it.who.edge(it.dayIdx, it.who.days);
    if (rand() < Math.abs(edge)) {
      const base = { entry: e.entry, distance: (e.entry * band.bps) / 1e4, locked_at: e.locked_at, expires_at: e.locked_at + horizon };
      const good: Direction | null = outcome(it.pair, { ...base, direction: 'long' }).status === 'win' ? 'long' : outcome(it.pair, { ...base, direction: 'short' }).status === 'win' ? 'short' : null;
      if (good) direction = edge > 0 ? good : good === 'long' ? 'short' : 'long';
    }
  }
  const call = insertCall(db, { traderId, pair: it.pair, board: it.board, direction, bandBps: band.bps, entry: e.entry, lockedAt: e.locked_at, simulated: true });
  applyOutcome(db, call.id, outcome(it.pair, call as CallRow));
  accepted++;
  // the copier follows Maya 2–6 minutes later on the same trade
  if (it.who.name === copier.copies && rand() < 0.85) {
    const ins = { t: e.locked_at + (2 + rand() * 4) * M, who: copier, pair: it.pair, board: it.board, dayIdx: 0, copyOf: call.id };
    let j = i + 1; while (j < queue.length && queue[j].t <= ins.t) j++;
    queue.splice(j, 0, ins);
  }
}

// Re-settle every trading day so demo players' history includes their daily 65% club results and streaks.
db.exec('DELETE FROM daily_rewards'); db.prepare("DELETE FROM settings WHERE key = 'rewards_next_day'").run();
const settled = settleDue(db, Date.now());
setSetting(db, 'demo_seeded_at', String(Date.now()));

console.log(`Seeded ${PERSONAS.length} DEMO players: ${accepted} calls accepted, ${rejected} intents rejected by the rules, ${new Set(settled.map((r) => r.day)).size} trading days settled.`);
const rows = db.prepare(`SELECT t.name, t.sim_skill AS scenario,
    SUM(c.status='win') AS pass, SUM(c.status='loss') AS failed, SUM(c.status='wash') AS nores,
    (SELECT ROUND(COALESCE(SUM(points),0)) FROM daily_rewards r WHERE r.trader_id = t.id) AS points,
    (SELECT COALESCE(SUM(eligible),0) FROM daily_rewards r WHERE r.trader_id = t.id) AS club_days
  FROM traders t LEFT JOIN calls c ON c.trader_id = t.id WHERE t.sim_skill LIKE 'demo:%' GROUP BY t.id ORDER BY points DESC`).all();
console.table(rows);
