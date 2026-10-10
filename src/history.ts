import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { candlesRange, type Candle } from './market.js';

/** 1m candles for [start, end), cached on disk per pair and range so replays are repeatable. */
export async function history1m(symbol: string, start: number, end: number): Promise<Candle[]> {
  mkdirSync('data/cache', { recursive: true });
  const file = `data/cache/${symbol}-${start}-${end}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const cs = await candlesRange(symbol, '1m', start, end);
  writeFileSync(file, JSON.stringify(cs));
  return cs;
}

/** First index with ts >= t. */
export function lowerBound(cs: Candle[], t: number) {
  let lo = 0, hi = cs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cs[m].ts < t) lo = m + 1; else hi = m; }
  return lo;
}
