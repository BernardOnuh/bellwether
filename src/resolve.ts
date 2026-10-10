import type { Direction } from './config.js';
import type { Candle } from './market.js';

export interface Bracket {
  direction: Direction;
  entry: number;
  distance: number;
  locked_at: number;
  expires_at: number;
}

export type Outcome =
  | { status: 'win' | 'loss'; at: number; exit: number }
  | { status: 'wash'; reason: 'expired' | 'ambiguous'; at: number; exit: number };

export const levels = (b: Pick<Bracket, 'direction' | 'entry' | 'distance'>) => {
  const s = b.direction === 'long' ? 1 : -1;
  return { target: b.entry + s * b.distance, stop: b.entry - s * b.distance };
};

/**
 * Walk 1m candles that open after the lock minute and before expiry.
 * The lock-minute candle is skipped because part of it happened before the entry was locked.
 * A candle that touches both levels has an unknowable order, so it is a wash ("ambiguous").
 * Returns null while the call is still live (no hit yet and expiry not covered by data).
 */
export function resolveBracket(b: Bracket, cs: Candle[], now: number): Outcome | null {
  const { target, stop } = levels(b);
  const firstTs = Math.floor(b.locked_at / 60_000) * 60_000 + 60_000;
  let lastClose: number | undefined;
  for (const c of cs) {
    if (c.ts < firstTs) continue;
    if (c.ts >= b.expires_at) break;
    const hitTarget = b.direction === 'long' ? c.h >= target : c.l <= target;
    const hitStop = b.direction === 'long' ? c.l <= stop : c.h >= stop;
    if (hitTarget && hitStop) return { status: 'wash', reason: 'ambiguous', at: c.ts, exit: c.c };
    if (hitTarget) return { status: 'win', at: c.ts, exit: target };
    if (hitStop) return { status: 'loss', at: c.ts, exit: stop };
    lastClose = c.c;
  }
  if (now >= b.expires_at) return { status: 'wash', reason: 'expired', at: b.expires_at, exit: lastClose ?? b.entry };
  return null;
}

/** P&L of a bracket in R (1R = distance), net of round-trip cost. Ambiguous candles count as a full loss. */
export function pnlR(b: Bracket, o: Outcome, costFrac: number): number {
  const cost = (costFrac * b.entry) / b.distance;
  if (o.status !== 'wash') return (o.status === 'win' ? 1 : -1) - cost;
  if (o.reason === 'ambiguous') return -1 - cost;
  const s = b.direction === 'long' ? 1 : -1;
  return (s * (o.exit - b.entry)) / b.distance - cost;
}
