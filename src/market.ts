import { CATEGORY } from './config.js';

const BASE = process.env.BITGET_API_BASE_URL ?? 'https://api.bitget.com';

export interface Candle { ts: number; o: number; h: number; l: number; c: number; v: number }
export interface Ticker { symbol: string; ts: number; serverTs: number; last: number; bid: number; ask: number; mid: number }
export interface Instrument { symbol: string; minQty: number; qtyStep: number; pricePrecision: number; qtyPrecision: number; minNotional: number; takerFee: number }

async function get(path: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}?${qs}`);
    const body = (await res.json().catch(() => ({}))) as { code?: string; msg?: string; data?: unknown; requestTime?: number };
    if (res.ok && body.code === '00000') return body;
    if (attempt < 6 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    throw new Error(`Bitget ${path} ${res.status} ${body.code ?? ''} ${body.msg ?? ''}`);
  }
}

const toCandle = (r: string[]): Candle => ({ ts: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });

/** Most recent candles (up to 1000), oldest first. Includes the in-progress candle. */
export async function candles(symbol: string, interval: string, limit = 1000): Promise<Candle[]> {
  const b = await get('/api/v3/market/candles', { category: CATEGORY, symbol, interval, limit });
  return (b.data as string[][]).map(toCandle).sort((a, b) => a.ts - b.ts);
}

/**
 * Historical candles in [start, end), paging backwards. Oldest first.
 * The recent-candles endpoint pages 1000 at a time; history-candles (100 per page, 90 days) takes over when it runs dry.
 */
export async function candlesRange(symbol: string, interval: string, start: number, end: number): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  let cursor = end;
  let path = '/api/v3/market/candles', limit = 1000;
  while (cursor > start) {
    const b = await get(path, { category: CATEGORY, symbol, interval, limit, endTime: cursor });
    await new Promise((r) => setTimeout(r, 120));
    const rows = (b.data as string[][]).map(toCandle);
    if (!rows.length && path.endsWith('/candles')) { path = '/api/v3/market/history-candles'; limit = 100; continue; }
    if (!rows.length) break;
    for (const c of rows) if (c.ts >= start && c.ts < end) out.set(c.ts, c);
    const oldest = Math.min(...rows.map((c) => c.ts));
    if (oldest >= cursor) break;
    cursor = oldest;
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

export async function ticker(symbol: string): Promise<Ticker> {
  const b = await get('/api/v3/market/tickers', { category: CATEGORY, symbol });
  const t = (b.data as Record<string, string>[])[0];
  const bid = +t.bid1Price, ask = +t.ask1Price;
  return { symbol, ts: +t.ts, serverTs: Number(b.requestTime), last: +t.lastPrice, bid, ask, mid: (bid + ask) / 2 };
}

/** One request for every USDT perp ticker. */
export async function allTickers(): Promise<Map<string, Ticker>> {
  const b = await get('/api/v3/market/tickers', { category: CATEGORY });
  const out = new Map<string, Ticker>();
  for (const t of b.data as Record<string, string>[]) {
    const bid = +t.bid1Price, ask = +t.ask1Price;
    out.set(t.symbol, { symbol: t.symbol, ts: +t.ts, serverTs: Number(b.requestTime), last: +t.lastPrice, bid, ask, mid: (bid + ask) / 2 });
  }
  return out;
}

const instCache = new Map<string, Instrument>();
export async function instrument(symbol: string): Promise<Instrument> {
  const hit = instCache.get(symbol);
  if (hit) return hit;
  const b = await get('/api/v3/market/instruments', { category: CATEGORY, symbol });
  const r = (b.data as Record<string, string>[])[0];
  const inst = {
    symbol,
    minQty: +r.minOrderQty,
    qtyStep: +r.quantityMultiplier,
    pricePrecision: +r.pricePrecision,
    qtyPrecision: +r.quantityPrecision,
    minNotional: +r.minOrderAmount,
    takerFee: +r.takerFeeRate,
  };
  instCache.set(symbol, inst);
  return inst;
}

export const roundTo = (x: number, decimals: number) => Number(x.toFixed(decimals));
