import { PAIRS, RULES } from './config.js';
import { candles, ticker, type Candle } from './market.js';
import type { DB } from './db.js';

export interface PairProfile {
  pair: string;
  updated_at: number;
  price: number;
  spread: number;
  rv24h: number;          // daily realized vol (fraction)
  volatile: number;       // 1 = volatile (30m window), 0 = calm (8h window)
  window_min: number;
  typical_range: number;  // median high-low over the pair's window, in price units
  band_lo: number;        // allowed distance band, already floored by min_distance
  band_hi: number;
  min_distance: number;   // costMultiple x round-trip cost
  closed: number;         // 1 = market looks closed, no calls
}

/** Aggregate candles into fixed buckets aligned to epoch multiples of `ms`. */
export function resample(cs: Candle[], ms: number): Candle[] {
  const out: Candle[] = [];
  for (const c of cs) {
    const ts = Math.floor(c.ts / ms) * ms;
    const last = out[out.length - 1];
    if (last && last.ts === ts) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
    } else out.push({ ...c, ts });
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Daily realized vol from 5m closes over the trailing 24h. */
export function realizedVol(c5m: Candle[]): number {
  const r: number[] = [];
  for (let i = 1; i < c5m.length; i++) if (c5m[i - 1].c > 0) r.push(Math.log(c5m[i].c / c5m[i - 1].c));
  if (r.length < 2) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance * 288);
}

/**
 * Typical move for the window: median of the larger one-sided excursion from the window's open,
 * max(high - open, open - low), over completed windows that traded. A 1:1 bracket at this distance
 * is touched on one side in about half of windows; the full high-low range would make most calls wash.
 */
export function typicalRange(buckets: Candle[]): number {
  return median(buckets.slice(0, -1).filter((b) => b.v > 0).map((b) => Math.max(b.h - b.o, b.o - b.l)));
}

export function looksClosed(recent1m: Candle[]): boolean {
  if (!recent1m.length) return true;
  const zero = recent1m.filter((c) => c.v === 0).length;
  return zero / recent1m.length >= RULES.closedZeroVolShare;
}

export function buildProfile(a: {
  pair: string; now: number; price: number; spread: number;
  c5m: Candle[]; b30m: Candle[]; b8h: Candle[]; recent1m: Candle[];
}): PairProfile {
  const rv = realizedVol(a.c5m);
  const volatile = rv >= RULES.volThreshold;
  const range = typicalRange(volatile ? a.b30m : a.b8h);
  const cost = a.price * 2 * RULES.takerFee + a.spread;
  const minDistance = RULES.costMultiple * cost;
  return {
    pair: a.pair,
    updated_at: a.now,
    price: a.price,
    spread: a.spread,
    rv24h: rv,
    volatile: volatile ? 1 : 0,
    window_min: volatile ? RULES.volatileWindowMin : RULES.calmWindowMin,
    typical_range: range,
    band_lo: Math.max(RULES.bandLo * range, minDistance),
    band_hi: RULES.bandHi * range,
    min_distance: minDistance,
    closed: looksClosed(a.recent1m) ? 1 : 0,
  };
}

/** Build a profile at historical time `t` from a 1m candle history (used by the replay). */
export function profileFrom1m(pair: string, hist: Candle[], t: number, spread: number): PairProfile | null {
  const upto = hist.filter((c) => c.ts < t);
  const day = upto.filter((c) => c.ts >= t - 24 * 3600_000);
  const week = upto.filter((c) => c.ts >= t - 7 * 24 * 3600_000);
  if (day.length < 600) return null;
  return buildProfile({
    pair, now: t, price: upto[upto.length - 1].c, spread,
    c5m: resample(day, 5 * 60_000),
    b30m: resample(week, 30 * 60_000),
    b8h: resample(week, 8 * 3600_000),
    recent1m: upto.slice(-30),
  });
}

export async function fetchProfile(pair: string): Promise<PairProfile> {
  const [t, c5m, c30m, c1h, recent] = await Promise.all([
    ticker(pair),
    candles(pair, '5m', 288),
    candles(pair, '30m', 336),
    candles(pair, '1H', 504),
    candles(pair, '1m', 30),
  ]);
  return buildProfile({
    pair, now: Date.now(), price: t.mid, spread: t.ask - t.bid,
    c5m, b30m: c30m, b8h: resample(c1h, 8 * 3600_000), recent1m: recent,
  });
}

export function saveProfile(db: DB, p: PairProfile) {
  db.prepare(`INSERT INTO pair_profiles (pair, updated_at, price, spread, rv24h, volatile, window_min, typical_range, band_lo, band_hi, min_distance, closed)
    VALUES (:pair, :updated_at, :price, :spread, :rv24h, :volatile, :window_min, :typical_range, :band_lo, :band_hi, :min_distance, :closed)
    ON CONFLICT(pair) DO UPDATE SET updated_at=excluded.updated_at, price=excluded.price, spread=excluded.spread, rv24h=excluded.rv24h,
      volatile=excluded.volatile, window_min=excluded.window_min, typical_range=excluded.typical_range, band_lo=excluded.band_lo,
      band_hi=excluded.band_hi, min_distance=excluded.min_distance, closed=excluded.closed`).run({ ...p });
}

export function loadProfile(db: DB, pair: string): PairProfile | undefined {
  return db.prepare('SELECT * FROM pair_profiles WHERE pair = ?').get(pair) as PairProfile | undefined;
}

export async function refreshProfiles(db: DB) {
  const results = await Promise.allSettled(PAIRS.map((p) => fetchProfile(p.symbol)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') saveProfile(db, r.value);
    else console.error(`[profile] ${PAIRS[i].symbol}: ${r.reason}`);
  });
}
