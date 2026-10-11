// House bands: for each pair and board, the median one-sided move over the board's horizon,
// measured from session-time window starts over the trailing 30 days. A 1:1 bracket at this
// distance is touched on one side in about half of windows. Recalibrated daily; each call
// freezes the band in force when it was locked.
import { BANDS, BOARDS, PAIRS, boardsFor, type BoardId } from './config.js';
import type { DB } from './db.js';
import { history } from './history.js';
import { allTickers, type Candle } from './market.js';
import { boardOpen, crossesWeekend } from './sessions.js';
import { lowerBound } from './history.js';

export interface Band { pair: string; board: BoardId; bps: number; spread_bps: number; windows: number; listed: number; computed_at: number }
export interface Quote { pair: string; price: number; bid: number; ask: number; updated_at: number }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Median max(high − open, open − low) / open over horizon windows that start inside the US session. */
export function bandFromCandles(cs: Candle[], horizonMin: number, from: number, to: number, strideMin = BANDS.strideMin, board: BoardId = 'intraday') {
  const h = horizonMin * 60_000, step = strideMin * 60_000;
  const moves: number[] = [];
  for (let s = Math.ceil(from / step) * step; s + h <= to; s += step) {
    if (!boardOpen(board, s, 'us') || crossesWeekend(s + h, 'us')) continue;   // only windows a call could actually have
    let i = lowerBound(cs, s);
    if (!cs[i] || cs[i].ts >= s + step) continue;
    const open = cs[i].o;
    let hi = -Infinity, lo = Infinity, n = 0;
    for (; i < cs.length && cs[i].ts < s + h; i++, n++) { hi = Math.max(hi, cs[i].h); lo = Math.min(lo, cs[i].l); }
    const expected = h / (cs[1] ? cs[1].ts - cs[0].ts : 300_000);
    if (n < expected * 0.5) continue;
    moves.push(Math.max(hi - open, open - lo) / open);
  }
  return { bps: moves.length ? Math.round(median(moves) * 1e5) / 10 : NaN, windows: moves.length };
}

export function saveBand(db: DB, b: Band) {
  db.prepare(`INSERT INTO bands (pair, board, bps, spread_bps, windows, listed, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pair, board) DO UPDATE SET bps = excluded.bps, spread_bps = excluded.spread_bps, windows = excluded.windows,
    listed = excluded.listed, computed_at = excluded.computed_at`).run(b.pair, b.board, b.bps, b.spread_bps, b.windows, b.listed, b.computed_at);
  db.prepare('INSERT INTO band_history (pair, board, bps, spread_bps, listed, computed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.pair, b.board, b.bps, b.spread_bps, b.listed, b.computed_at);
}

export const loadBand = (db: DB, pair: string, board: BoardId) =>
  db.prepare('SELECT * FROM bands WHERE pair = ? AND board = ?').get(pair, board) as Band | undefined;
export const loadBands = (db: DB) => db.prepare('SELECT * FROM bands ORDER BY pair, board').all() as unknown as Band[];
export const loadQuote = (db: DB, pair: string) => db.prepare('SELECT * FROM quotes WHERE pair = ?').get(pair) as Quote | undefined;

export function makeBand(pair: string, board: BoardId, cs: Candle[], spreadBps: number, now: number): Band {
  const { bps, windows } = bandFromCandles(cs, BOARDS[board].horizonMin, now - BANDS.volWindowDays * 86_400_000, now, BANDS.strideMin, board);
  const listed = Number.isFinite(bps) && windows >= 20 && bps >= BANDS.minSpreadMultiple * spreadBps ? 1 : 0;
  return { pair, board, bps, spread_bps: spreadBps, windows, listed, computed_at: now };
}

/** Refresh live quotes for every pair (one request). */
export async function refreshQuotes(db: DB) {
  const tk = await allTickers();
  const now = Date.now();
  for (const p of PAIRS) {
    const t = tk.get(p.symbol);
    if (!t || !(t.bid > 0)) continue;
    db.prepare(`INSERT INTO quotes (pair, price, bid, ask, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pair) DO UPDATE SET price = excluded.price, bid = excluded.bid, ask = excluded.ask, updated_at = excluded.updated_at`)
      .run(p.symbol, t.mid, t.bid, t.ask, now);
  }
}

/** Recalibrate bands older than a day. Uses 5m candles over the trailing 30 days (cached per day). */
export async function refreshBands(db: DB, force = false) {
  const now = Date.now();
  await refreshQuotes(db);
  for (const p of PAIRS) {
    const stale = boardsFor(p.symbol).some((b) => { const x = loadBand(db, p.symbol, b); return force || !x || now - x.computed_at > BANDS.maxAgeMs; });
    if (!stale) continue;
    try {
      const day = Math.floor(now / 86_400_000) * 86_400_000;
      const cs = await history(p.symbol, '5m', day - BANDS.volWindowDays * 86_400_000, day);
      const q = loadQuote(db, p.symbol);
      const spreadBps = q ? ((q.ask - q.bid) / q.price) * 1e4 : 0;
      for (const b of boardsFor(p.symbol)) saveBand(db, makeBand(p.symbol, b, cs, spreadBps, day));
    } catch (e) {
      console.error(`[bands] ${p.symbol}: ${e}`);
    }
  }
}
