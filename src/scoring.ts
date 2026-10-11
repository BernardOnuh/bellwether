import { SCORING, type BoardId } from './config.js';
import type { DB } from './db.js';

const DAY = 86_400_000;

/** Wilson score interval bound for a binomial proportion. sign = -1 lower, +1 upper. */
export function wilson(wins: number, n: number, z: number, sign: -1 | 1): number {
  if (n === 0) return sign < 0 ? 0 : 1;
  const p = wins / n, z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (centre + sign * margin) / (1 + z2 / n);
}

/** Hit rate pulled toward 50% by a Beta(K/2, K/2) prior, so a short hot streak can't claim a top tier. */
export const shrunkRate = (wins: number, n: number, k = SCORING.tierPriorK) => (wins + k / 2) / (n + k);

export function tierFor(shrunk: number) {
  return SCORING.tiers.find((t) => shrunk >= t.min) ?? null;
}

/**
 * Habitual copiers as of `asOf`, judged across all boards: at least 8 of their decisive calls landed second behind
 * an established leader (10+ decisive calls, so throwaway accounts can't manufacture flags), and copies are at least
 * half of their decisive calls.
 */
export function copierSet(db: DB, asOf: number): Set<number> {
  const rows = db.prepare(`SELECT c.trader_id,
      COUNT(*) AS decisive,
      SUM(CASE WHEN c.copied_from IS NOT NULL AND (
        SELECT COUNT(*) FROM calls d WHERE d.trader_id = l.trader_id AND d.status IN ('win','loss') AND d.resolved_at <= ?) >= ? THEN 1 ELSE 0 END) AS copies
    FROM calls c LEFT JOIN calls l ON l.id = c.copied_from
    WHERE c.status IN ('win','loss') AND c.resolved_at <= ?
    GROUP BY c.trader_id`).all(asOf, SCORING.copyLeaderMinDecisive, asOf) as { trader_id: number; decisive: number; copies: number }[];
  return new Set(rows.filter((r) => r.copies >= SCORING.copyMinCopies && r.copies / r.decisive >= SCORING.copyHabitualShare).map((r) => r.trader_id));
}

export type Status = 'eliminated' | 'warmup' | 'unqualified' | 'below tier' | 'BASE' | 'SHARP' | 'WOLF';

export interface TraderStats {
  trader_id: number; name: string; board: BoardId;
  wins: number; losses: number; washes: number; open: number;   // reputation window, copied wins already counted as losses
  decisive: number; hitRate: number; shrunk: number; lb: number;
  qualified: boolean; tier: string | null; mult: number;
  warmup: boolean; warmupEndsAt: number | null;
  eliminated: boolean; copier: boolean; copies: number;
  points: number; pointWins: number;                            // trailing 7-day decayed, tier-weighted wins (cap 20)
  status: Status;
}

interface Row { trader_id: number; status: string; locked_at: number; resolved_at: number | null; copied_from: number | null }

/**
 * Board stats per trader as of `asOf`, using only outcomes known by then (no look-ahead in replays).
 * - Qualify: >= 8 decisive in the reputation window and Wilson lower bound (z = 1.28) >= 50%.
 * - Tier: shrunk rate >= 55% BASE 1x, >= 60% SHARP 1.2x, >= 70% WOLF 2x.
 * - Points: wins resolved in the last 7 days, newest 20, each worth tier x linear decay; warmup wins pay nothing.
 * - Habitual copiers (landed second on >= 50% of decisive calls, >= 8 copies): copied wins count as losses.
 * - Elimination: >= 40 lifetime decisive and Wilson upper bound < 45%.
 */
export function boardStats(db: DB, board: BoardId, asOf = Date.now()): Map<number, TraderStats> {
  const traders = db.prepare('SELECT id, name, first_call_at FROM traders').all() as { id: number; name: string; first_call_at: number | null }[];
  const rows = db.prepare('SELECT trader_id, status, locked_at, resolved_at, copied_from FROM calls WHERE board = ? AND locked_at <= ? ORDER BY resolved_at')
    .all(board, asOf) as unknown as Row[];
  const by = new Map<number, Row[]>();
  for (const r of rows) (by.get(r.trader_id) ?? by.set(r.trader_id, []).get(r.trader_id)!).push(r);

  const copiers = copierSet(db, asOf);
  const out = new Map<number, TraderStats>();
  for (const t of traders) {
    const mine = by.get(t.id) ?? [];
    const known = mine.filter((r) => r.resolved_at !== null && r.resolved_at <= asOf);
    const open = mine.length - known.length;
    const decisiveAll = known.filter((r) => r.status === 'win' || r.status === 'loss');
    const copies = decisiveAll.filter((r) => r.copied_from !== null).length;
    const copier = copiers.has(t.id);
    const isWin = (r: Row) => r.status === 'win' && !(copier && r.copied_from !== null);

    // reputation window: last 60 days, newest 100 decisive
    const rep = decisiveAll.filter((r) => r.resolved_at! > asOf - SCORING.reputationDays * DAY).slice(-SCORING.reputationMaxDecisive);
    const wins = rep.filter(isWin).length, n = rep.length;
    const washes = known.filter((r) => r.status === 'wash' && r.resolved_at! > asOf - SCORING.reputationDays * DAY).length;
    const shrunk = shrunkRate(wins, n);
    const lb = wilson(wins, n, SCORING.qualifyZ, -1);
    const qualified = n >= SCORING.qualifyMinDecisive && lb >= SCORING.qualifyLbFloor;
    const lifeWins = decisiveAll.filter(isWin).length;
    const eliminated = decisiveAll.length >= SCORING.elimMinDecisive && wilson(lifeWins, decisiveAll.length, SCORING.qualifyZ, 1) < SCORING.elimUbCeil;
    const warmupEndsAt = t.first_call_at === null ? null : t.first_call_at + SCORING.warmupDays * DAY;
    const warmup = warmupEndsAt === null || asOf < warmupEndsAt;
    const tier = qualified && !eliminated ? tierFor(shrunk) : null;
    const mult = tier?.mult ?? 0;

    let points = 0, pointWins = 0;
    if (mult > 0) {
      const recent = rep.filter((r) => isWin(r) && r.resolved_at! > asOf - SCORING.pointsDecayDays * DAY && warmupEndsAt !== null && r.locked_at >= warmupEndsAt)
        .slice(-SCORING.winCap);
      pointWins = recent.length;
      for (const r of recent) points += mult * (1 - (asOf - r.resolved_at!) / (SCORING.pointsDecayDays * DAY));
    }
    const status: Status = eliminated ? 'eliminated' : warmup && mine.length ? 'warmup' : !qualified ? 'unqualified' : tier ? (tier.name as Status) : 'below tier';
    out.set(t.id, {
      trader_id: t.id, name: t.name, board, wins, losses: n - wins, washes, open, decisive: n,
      hitRate: n ? wins / n : NaN, shrunk, lb, qualified, tier: tier?.name ?? null, mult,
      warmup, warmupEndsAt, eliminated, copier, copies, points, pointWins, status,
    });
  }
  return out;
}

export function leaderboard(db: DB, board: BoardId, asOf?: number): TraderStats[] {
  return [...boardStats(db, board, asOf).values()]
    .filter((s) => s.decisive + s.washes + s.open > 0)
    .sort((a, b) => b.points - a.points || Number(b.qualified) - Number(a.qualified) || b.shrunk - a.shrunk || b.decisive - a.decisive);
}

export const TIER_BADGE: Record<string, string> = { WOLF: '🐺', SHARP: '🎯', BASE: '✅' };
