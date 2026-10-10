import { CONSENSUS, type Direction } from './config.js';
import type { DB } from './db.js';
import type { PairProfile } from './profile.js';
import { allStats, type CallRow } from './scoring.js';

export interface Signal {
  id?: number;
  pair: string;
  direction: Direction;
  created_at: number;
  n_traders: number;
  weight: number;
  agreement: number;
  distance: number;
  window_min: number;
  call_ids: number[];
  voters: { trader_id: number; name: string; rankScore: number; weight: number }[];
}

/** Pairwise check: do two traders' past calls look like copies of each other? */
function areClones(db: DB, a: number, b: number, before: number): boolean {
  const r = db.prepare(`SELECT COUNT(*) AS n, SUM(x.direction = y.direction) AS same
    FROM calls x JOIN calls y ON x.pair = y.pair AND ABS(x.locked_at - y.locked_at) <= ?
    WHERE x.trader_id = ? AND y.trader_id = ? AND x.locked_at < ? AND y.locked_at < ?`)
    .get(CONSENSUS.corrNearMs, a, b, before, before) as { n: number; same: number | null };
  return r.n >= CONSENSUS.corrMinOverlap && (r.same ?? 0) / r.n >= CONSENSUS.corrMaxAgree;
}

function weightedMedian(xs: { v: number; w: number }[]) {
  const s = [...xs].sort((a, b) => a.v - b.v);
  const half = s.reduce((a, x) => a + x.w, 0) / 2;
  let acc = 0;
  for (const x of s) if ((acc += x.w) >= half) return x.v;
  return s[s.length - 1].v;
}

/**
 * Weighted agreement among qualified traders with calls open on `pair` that were locked in the look-back window.
 * Weight = edge over a coin flip (rankScore - 0.5), using only information available at `now`.
 */
export function detectConsensus(db: DB, profile: PairProfile, now: number): Signal | null {
  const lookback = profile.window_min * 60_000 * CONSENSUS.windowFrac;
  const calls = db.prepare(`SELECT * FROM calls WHERE pair = ? AND locked_at > ? AND locked_at <= ?
    AND (resolved_at IS NULL OR resolved_at > ?) ORDER BY locked_at`)
    .all(profile.pair, now - lookback, now, now) as unknown as CallRow[];
  if (calls.length < CONSENSUS.minTraders) return null;

  const stats = allStats(db, now);
  const votes = calls
    .map((c) => ({ c, s: stats.get(c.trader_id)! }))
    .filter((v) => v.s?.qualified && v.s.rankScore > 0.5)
    .map((v) => ({ ...v, w: v.s.rankScore - 0.5 }));

  // Collapse clones: within each side, a trader that copies a heavier voter adds no weight.
  const independent: typeof votes = [];
  for (const v of [...votes].sort((a, b) => b.w - a.w)) {
    const clone = independent.some((u) => u.c.direction === v.c.direction && areClones(db, u.c.trader_id, v.c.trader_id, now));
    if (!clone) independent.push(v);
  }

  const side = (d: Direction) => independent.filter((v) => v.c.direction === d);
  const W = (vs: typeof independent) => vs.reduce((a, v) => a + v.w, 0);
  const total = W(independent);
  for (const d of ['long', 'short'] as Direction[]) {
    const vs = side(d);
    if (vs.length < CONSENSUS.minTraders || W(vs) / total < CONSENSUS.minAgreement) continue;
    const recent = db.prepare('SELECT 1 FROM signals WHERE pair = ? AND direction = ? AND created_at > ?').get(profile.pair, d, now - lookback);
    if (recent) return null;
    const distance = Math.min(profile.band_hi, Math.max(profile.band_lo, weightedMedian(vs.map((v) => ({ v: v.c.distance, w: v.w })))));
    return {
      pair: profile.pair, direction: d, created_at: now, n_traders: vs.length, weight: W(vs), agreement: W(vs) / total,
      distance, window_min: profile.window_min, call_ids: vs.map((v) => v.c.id),
      voters: vs.map((v) => ({ trader_id: v.s.trader_id, name: v.s.name, rankScore: v.s.rankScore, weight: v.w })),
    };
  }
  return null;
}

export function saveSignal(db: DB, s: Signal, simulated = false): Signal {
  const r = db.prepare(`INSERT INTO signals (pair, direction, created_at, n_traders, weight, agreement, distance, window_min, call_ids, simulated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.pair, s.direction, s.created_at, s.n_traders, s.weight, s.agreement, s.distance,
    s.window_min, JSON.stringify({ calls: s.call_ids, voters: s.voters }), simulated ? 1 : 0);
  return { ...s, id: Number(r.lastInsertRowid) };
}
