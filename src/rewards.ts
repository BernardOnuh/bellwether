// Daily rewards: the "65% club". Settled once per New York trading day, after its swing calls resolve.
import { BOARD_IDS, REWARDS, SESSION } from './config.js';
import type { DB } from './db.js';
import { getSetting, setSetting } from './db.js';
import { boardStats } from './scoring.js';
import { etDay, etDayEnd, isTradingDay, prevTradingDay } from './sessions.js';

export interface DailyReward {
  day: string; trader_id: number; name?: string;
  eligible: number; reason: string | null;
  rolling_wins: number; rolling_n: number; calls_today: number; wins_today: number;
  mult: number; weight: number; points: number; streak: number;
}

const DDL = `CREATE TABLE IF NOT EXISTS daily_rewards (
  day TEXT NOT NULL, trader_id INTEGER NOT NULL REFERENCES traders(id),
  eligible INTEGER NOT NULL, reason TEXT,
  rolling_wins INTEGER NOT NULL, rolling_n INTEGER NOT NULL, calls_today INTEGER NOT NULL, wins_today INTEGER NOT NULL,
  mult REAL NOT NULL, weight REAL NOT NULL, points REAL NOT NULL, streak INTEGER NOT NULL,
  PRIMARY KEY (day, trader_id)
)`;
export const ensureRewardsTable = (db: DB) => db.exec(DDL);

/** Warmup status at `asOf`: days since first call and distinct New York trading days with at least one call. */
export function warmupStatus(db: DB, traderId: number, asOf: number) {
  const t = db.prepare('SELECT first_call_at FROM traders WHERE id = ?').get(traderId) as { first_call_at: number | null } | undefined;
  const first = t?.first_call_at ?? null;
  if (first === null || first > asOf) return { started: false, days: 0, activeDays: 0, done: false, endsAt: null as number | null };
  const days = Math.floor((asOf - first) / 86_400_000);
  const rows = db.prepare('SELECT locked_at FROM calls WHERE trader_id = ? AND locked_at <= ?').all(traderId, asOf) as { locked_at: number }[];
  const activeDays = new Set(rows.map((r) => etDay(r.locked_at))).size;
  return {
    started: true, days, activeDays, endsAt: first + REWARDS.warmupDays * 86_400_000,
    done: days >= REWARDS.warmupDays && activeDays >= REWARDS.warmupActiveDays,
  };
}

interface Decisive { trader_id: number; board: string; status: string; copied_from: number | null; resolved_at: number }

/** Last-20 rolling record per trader as of `asOf`, across both boards; a habitual copier's copied wins count as losses. */
export function rollingRecord(db: DB, asOf: number) {
  const copier = new Map<string, boolean>(), eliminated = new Set<number>(), mult = new Map<number, number>();
  for (const b of BOARD_IDS) for (const s of boardStats(db, b, asOf).values()) {
    copier.set(`${s.trader_id}:${b}`, s.copier);
    if (s.eliminated) eliminated.add(s.trader_id);
    mult.set(s.trader_id, Math.max(mult.get(s.trader_id) ?? 1, s.mult || 1));
  }
  const rows = db.prepare(`SELECT trader_id, board, status, copied_from, resolved_at FROM calls
    WHERE status IN ('win','loss') AND resolved_at <= ? ORDER BY resolved_at`).all(asOf) as unknown as Decisive[];
  const by = new Map<number, Decisive[]>();
  for (const r of rows) (by.get(r.trader_id) ?? by.set(r.trader_id, []).get(r.trader_id)!).push(r);
  const isWin = (r: Decisive) => r.status === 'win' && !(copier.get(`${r.trader_id}:${r.board}`) && r.copied_from !== null);
  const out = new Map<number, { wins: number; n: number; eliminated: boolean; copier: boolean; mult: number }>();
  for (const [id, rs] of by) {
    const last = rs.slice(-REWARDS.rollingDecisive);
    out.set(id, {
      wins: last.filter(isWin).length, n: last.length, eliminated: eliminated.has(id),
      copier: BOARD_IDS.some((b) => copier.get(`${id}:${b}`)), mult: mult.get(id) ?? 1,
    });
  }
  return out;
}

/** Settle one New York day: decide eligibility, split the pool, update streaks. Idempotent. */
export function settleDay(db: DB, day: string, mode = SESSION.mode): DailyReward[] {
  ensureRewardsTable(db);
  if (db.prepare('SELECT 1 FROM daily_rewards WHERE day = ? LIMIT 1').get(day)) return loadDay(db, day);
  const from = etDayEnd(prevDayStr(day)), to = etDayEnd(day);
  const asOf = to + REWARDS.settleDelayMin * 60_000;
  const today = db.prepare(`SELECT trader_id, COUNT(*) AS calls, SUM(status = 'win') AS wins FROM calls
    WHERE locked_at >= ? AND locked_at < ? GROUP BY trader_id`).all(from, to) as { trader_id: number; calls: number; wins: number }[];
  const roll = rollingRecord(db, asOf);
  const prev = prevTradingDay(day, mode);
  const prevStreak = new Map((db.prepare('SELECT trader_id, streak FROM daily_rewards WHERE day = ? AND eligible = 1').all(prev) as { trader_id: number; streak: number }[])
    .map((r) => [r.trader_id, r.streak]));

  const rows: DailyReward[] = today.map((t) => {
    const r = roll.get(t.trader_id) ?? { wins: 0, n: 0, eliminated: false, copier: false, mult: 1 };
    const w = warmupStatus(db, t.trader_id, asOf);
    const reason = r.eliminated ? 'eliminated' : r.copier ? 'flagged as copier'
      : !w.done ? `warmup: day ${Math.min(w.days, REWARDS.warmupDays)} of ${REWARDS.warmupDays}, active on ${Math.min(w.activeDays, REWARDS.warmupActiveDays)} of ${REWARDS.warmupActiveDays} trading days`
      : t.calls < REWARDS.minCallsToday ? `${t.calls} call today, need ${REWARDS.minCallsToday}`
      : r.n < REWARDS.rollingDecisive ? `${r.n} of ${REWARDS.rollingDecisive} wins+losses so far`
      : r.wins / r.n < REWARDS.minRate ? `last ${r.n}: ${r.wins} wins (${Math.round((r.wins / r.n) * 100)}%), need ${Math.ceil(REWARDS.minRate * r.n)}`
      : null;
    const eligible = reason === null ? 1 : 0;
    const wins = t.wins ?? 0;
    return {
      day, trader_id: t.trader_id, eligible, reason, rolling_wins: r.wins, rolling_n: r.n, calls_today: t.calls, wins_today: wins,
      mult: r.mult, weight: eligible ? Math.max(wins, 1) * r.mult : 0, points: 0, streak: eligible ? (prevStreak.get(t.trader_id) ?? 0) + 1 : 0,
    };
  });
  const W = rows.reduce((a, r) => a + r.weight, 0);
  for (const r of rows) r.points = W ? Math.round((REWARDS.dailyPool * r.weight) / W * 100) / 100 : 0;
  const ins = db.prepare(`INSERT INTO daily_rewards (day, trader_id, eligible, reason, rolling_wins, rolling_n, calls_today, wins_today, mult, weight, points, streak)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) ins.run(r.day, r.trader_id, r.eligible, r.reason, r.rolling_wins, r.rolling_n, r.calls_today, r.wins_today, r.mult, r.weight, r.points, r.streak);
  return rows;
}

const prevDayStr = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

export const loadDay = (db: DB, day: string) =>
  db.prepare('SELECT r.*, t.name FROM daily_rewards r JOIN traders t ON t.id = r.trader_id WHERE day = ? ORDER BY points DESC').all(day) as unknown as DailyReward[];

/** Settle every finished trading day since the last one settled. Returns newly settled rows. */
export function settleDue(db: DB, now = Date.now(), mode = SESSION.mode): DailyReward[] {
  ensureRewardsTable(db);
  const first = (db.prepare('SELECT MIN(locked_at) AS t FROM calls').get() as { t: number | null }).t;
  if (first === null) return [];
  let day = getSetting(db, 'rewards_next_day') ?? etDay(first);
  const out: DailyReward[] = [];
  while (etDayEnd(day) + REWARDS.settleDelayMin * 60_000 <= now) {
    if (isTradingDay(day, mode)) out.push(...settleDay(db, day, mode));
    const [y, m, d] = day.split('-').map(Number);
    day = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    setSetting(db, 'rewards_next_day', day);
  }
  return out;
}

export interface RewardStanding { trader_id: number; name: string; points7d: number; pointsAll: number; streak: number; qualifiedDays: number; rolling: string }

/** Reward leaderboard: points over the last 7 settled days and all-time, current streak. */
export function rewardBoard(db: DB, now = Date.now()): RewardStanding[] {
  ensureRewardsTable(db);
  const since = etDay(now - 7 * 86_400_000);
  const rows = db.prepare(`SELECT t.id AS trader_id, t.name,
      ROUND(COALESCE(SUM(CASE WHEN r.day > ? THEN r.points END), 0), 2) AS points7d,
      ROUND(COALESCE(SUM(r.points), 0), 2) AS pointsAll,
      COALESCE(SUM(r.eligible), 0) AS qualifiedDays,
      (SELECT streak FROM daily_rewards x WHERE x.trader_id = t.id ORDER BY day DESC LIMIT 1) AS streak
    FROM traders t LEFT JOIN daily_rewards r ON r.trader_id = t.id
    GROUP BY t.id HAVING EXISTS (SELECT 1 FROM calls c WHERE c.trader_id = t.id)
    ORDER BY points7d DESC, pointsAll DESC`).all(since) as unknown as Omit<RewardStanding, 'rolling'>[];
  const roll = rollingRecord(db, now);
  return rows.map((r) => {
    const x = roll.get(r.trader_id);
    return { ...r, streak: r.streak ?? 0, rolling: x ? `${x.wins}/${x.n}` : '0/0' };
  });
}

/** Live progress for one trader today (for /stats). */
export function todayProgress(db: DB, traderId: number, now = Date.now()) {
  const day = etDay(now);
  const from = etDayEnd(prevDayStr(day));
  const { calls } = db.prepare('SELECT COUNT(*) AS calls FROM calls WHERE trader_id = ? AND locked_at >= ?').get(traderId, from) as { calls: number };
  const r = rollingRecord(db, now).get(traderId) ?? { wins: 0, n: 0 };
  const need = Math.ceil(REWARDS.minRate * REWARDS.rollingDecisive);
  const warmup = warmupStatus(db, traderId, now);
  return {
    day, calls, wins: r.wins, n: r.n, need, warmup,
    onTrack: warmup.done && r.n >= REWARDS.rollingDecisive && r.wins / r.n >= REWARDS.minRate && calls >= REWARDS.minCallsToday,
  };
}
