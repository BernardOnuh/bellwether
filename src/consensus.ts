import { BOARDS, CONSENSUS, type BoardId, type Direction } from './config.js';
import type { DB } from './db.js';
import type { CallRow } from './calls.js';
import { boardStats } from './scoring.js';

export interface Signal {
  id?: number;
  board: BoardId;
  pair: string;
  direction: Direction;
  created_at: number;
  n_traders: number;
  weight: number;
  agreement: number;
  band_bps: number;
  call_ids: number[];
  voters: { trader_id: number; name: string; tier: string | null; shrunk: number; weight: number }[];
}

/**
 * Weighted agreement among qualified traders with calls open on one pair and board, locked within
 * the look-back. Weight = edge over a coin flip (shrunk rate − 0.5). Agreeing with an earlier caller is fine;
 * habitual copiers and eliminated traders carry no weight. Uses only what was known at `now`.
 */
export function detectConsensus(db: DB, pair: string, board: BoardId, now: number, bandBps: number): Signal | null {
  const lookback = BOARDS[board].horizonMin * 60_000 * CONSENSUS.lookbackFrac;
  const calls = db.prepare(`SELECT * FROM calls WHERE pair = ? AND board = ? AND locked_at > ? AND locked_at <= ?
    AND (resolved_at IS NULL OR resolved_at > ?) ORDER BY locked_at`)
    .all(pair, board, now - lookback, now, now) as unknown as CallRow[];
  if (calls.length < CONSENSUS.minTraders) return null;

  const stats = boardStats(db, board, now);
  const votes = calls
    .map((c) => ({ c, s: stats.get(c.trader_id)! }))
    .filter((v) => v.s && v.s.qualified && !v.s.eliminated && !v.s.copier && v.s.shrunk > 0.5)
    .map((v) => ({ ...v, w: v.s.shrunk - 0.5 }));
  const total = votes.reduce((a, v) => a + v.w, 0);
  for (const d of ['long', 'short'] as Direction[]) {
    const vs = votes.filter((v) => v.c.direction === d);
    const W = vs.reduce((a, v) => a + v.w, 0);
    if (vs.length < CONSENSUS.minTraders || W / total < CONSENSUS.minAgreement) continue;
    if (db.prepare('SELECT 1 FROM signals WHERE pair = ? AND board = ? AND direction = ? AND created_at > ?').get(pair, board, d, now - lookback)) return null;
    return {
      board, pair, direction: d, created_at: now, n_traders: vs.length, weight: W, agreement: W / total, band_bps: bandBps,
      call_ids: vs.map((v) => v.c.id),
      voters: vs.map((v) => ({ trader_id: v.s.trader_id, name: v.s.name, tier: v.s.tier, shrunk: v.s.shrunk, weight: v.w })),
    };
  }
  return null;
}

export function saveSignal(db: DB, s: Signal, simulated = false): Signal {
  const r = db.prepare(`INSERT INTO signals (board, pair, direction, created_at, n_traders, weight, agreement, band_bps, call_ids, simulated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.board, s.pair, s.direction, s.created_at, s.n_traders, s.weight, s.agreement, s.band_bps,
    JSON.stringify({ calls: s.call_ids, voters: s.voters }), simulated ? 1 : 0);
  return { ...s, id: Number(r.lastInsertRowid) };
}
