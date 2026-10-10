import { RULES } from './config.js';
import type { DB } from './db.js';

export interface CallRow {
  id: number; trader_id: number; pair: string; direction: 'long' | 'short'; distance: number; entry: number;
  target: number; stop: number; window_min: number; band_ratio: number; locked_at: number; expires_at: number;
  status: 'open' | 'win' | 'loss' | 'wash'; wash_reason: string | null; exit_price: number | null;
  resolved_at: number | null; simulated: number;
}

export interface TraderStats {
  trader_id: number;
  name: string;
  calls: number;      // resolved calls
  open: number;
  wins: number;
  losses: number;
  washes: number;
  hitRate: number;    // wins / (wins + losses)
  shrunk: number;     // (wins + 5) / (wins + losses + 10)
  washRate: number;
  avgBand: number;    // mean distance / typical range
  rankScore: number;  // shrunk, cut when wash rate is high
  qualified: boolean;
}

/** Crowd wash rate over resolved calls; the baseline a trader's own wash rate is judged against. */
export function crowdWashRate(calls: Pick<CallRow, 'status'>[]): number {
  const resolved = calls.filter((c) => c.status !== 'open');
  return resolved.length ? resolved.filter((c) => c.status === 'wash').length / resolved.length : 0;
}

export function statsFor(trader_id: number, name: string, calls: Pick<CallRow, 'status' | 'band_ratio'>[], crowdWash = 0.5): TraderStats {
  let wins = 0, losses = 0, washes = 0, open = 0, band = 0, resolved = 0;
  for (const c of calls) {
    if (c.status === 'open') { open++; continue; }
    resolved++;
    band += c.band_ratio;
    if (c.status === 'win') wins++;
    else if (c.status === 'loss') losses++;
    else washes++;
  }
  const decided = wins + losses;
  const shrunk = (wins + RULES.priorWins) / (decided + RULES.priorTotal);
  const washRate = resolved ? washes / resolved : 0;
  const rankScore = shrunk * (1 - RULES.washPenalty * Math.max(0, washRate - crowdWash - RULES.washSlack));
  return {
    trader_id, name, calls: resolved, open, wins, losses, washes,
    hitRate: decided ? wins / decided : NaN,
    shrunk, washRate, avgBand: resolved ? band / resolved : NaN, rankScore,
    qualified: decided >= RULES.minDecided,
  };
}

/**
 * Stats for every trader using only calls resolved by `asOf` (no look-ahead in replays).
 * Calls still open at `asOf` count as open even if they resolved later.
 */
export function allStats(db: DB, asOf = Number.MAX_SAFE_INTEGER): Map<number, TraderStats> {
  const traders = db.prepare('SELECT id, name FROM traders').all() as { id: number; name: string }[];
  const rows = db.prepare('SELECT trader_id, status, band_ratio, resolved_at, locked_at FROM calls WHERE locked_at <= ?').all(asOf) as
    { trader_id: number; status: CallRow['status']; band_ratio: number; resolved_at: number | null }[];
  const byTrader = new Map<number, Pick<CallRow, 'status' | 'band_ratio'>[]>();
  const all: Pick<CallRow, 'status'>[] = [];
  for (const r of rows) {
    const status = r.resolved_at !== null && r.resolved_at <= asOf ? r.status : 'open';
    (byTrader.get(r.trader_id) ?? byTrader.set(r.trader_id, []).get(r.trader_id)!).push({ status, band_ratio: r.band_ratio });
    all.push({ status });
  }
  const crowd = crowdWashRate(all);
  return new Map(traders.map((t) => [t.id, statsFor(t.id, t.name, byTrader.get(t.id) ?? [], crowd)]));
}

export function leaderboard(db: DB, asOf?: number): TraderStats[] {
  return [...allStats(db, asOf).values()]
    .filter((s) => s.calls + s.open > 0)
    .sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.rankScore - a.rankScore || b.calls - a.calls);
}
