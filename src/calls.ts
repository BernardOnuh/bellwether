import { createHash, randomBytes } from 'node:crypto';
import { BOARDS, RULES, SCORING, boardsFor, label, pairBySymbol, type BoardId, type Direction } from './config.js';
import type { DB } from './db.js';
import { loadBand, type Band } from './bands.js';
import { candles, ticker, type Ticker } from './market.js';
import { levels, resolveBracket } from './resolve.js';
import { crossesWeekend, sessionLine, sessionOpen } from './sessions.js';

export interface CallRow {
  id: number; trader_id: number; board: BoardId; pair: string; direction: Direction; band_bps: number; distance: number;
  entry: number; target: number; stop: number; locked_at: number; expires_at: number;
  status: 'open' | 'win' | 'loss' | 'wash'; wash_reason: string | null; exit_price: number | null; resolved_at: number | null;
  copied_from: number | null; commit_hash: string; salt: string; simulated: number;
}

export class CallRejected extends Error {}

const dayStart = (t: number) => Math.floor(t / 86_400_000) * 86_400_000;

/** The sealed form of a call. Published as a hash while open; the salt is revealed after it resolves. */
export const commitPayload = (c: Pick<CallRow, 'trader_id' | 'board' | 'pair' | 'direction' | 'entry' | 'band_bps' | 'locked_at' | 'salt'>) =>
  JSON.stringify([c.trader_id, c.board, c.pair, c.direction, c.entry, c.band_bps, c.locked_at, c.salt]);
export const commitHash = (c: Parameters<typeof commitPayload>[0]) => createHash('sha256').update(commitPayload(c)).digest('hex');

/** Every rule that can be checked before fetching a price. Throws CallRejected with a reason a trader can act on. */
export function checkCall(db: DB, a: { traderId: number; pair: string; board: BoardId; now: number; band?: Band; mode?: 'us' | 'always' }) {
  const board = BOARDS[a.board];
  if (!pairBySymbol(a.pair)) throw new CallRejected(`Unknown pair ${a.pair}.`);
  if (!boardsFor(a.pair).includes(a.board))
    throw new CallRejected(`${label(a.pair)} trades on ${boardsFor(a.pair).map((b) => BOARDS[b].title).join(' and ')} only.`);
  if (!sessionOpen(a.now, a.mode)) throw new CallRejected(sessionLine(a.now));
  if (a.mode !== 'always' && crossesWeekend(a.now + board.horizonMin * 60_000)) throw new CallRejected(`A ${board.title} call now would run into the weekend. Try the shorter board or wait for Monday.`);
  const band = a.band;
  if (!band || !Number.isFinite(band.bps)) throw new CallRejected('Bands are not calibrated yet, try again shortly.');
  if (!band.listed) throw new CallRejected(`${label(a.pair)} is not listed on the ${board.title} board (band too tight versus spread).`);
  const open = db.prepare('SELECT 1 FROM calls WHERE trader_id = ? AND pair = ? AND board = ? AND locked_at <= ? AND (resolved_at IS NULL OR resolved_at > ?)')
    .get(a.traderId, a.pair, a.board, a.now, a.now);
  if (open) throw new CallRejected(`You already have an open ${board.title} call on ${label(a.pair)}.`);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM calls WHERE trader_id = ? AND board = ? AND locked_at >= ? AND locked_at <= ?')
    .get(a.traderId, a.board, dayStart(a.now), a.now) as { n: number };
  if (n >= board.dailyCap) throw new CallRejected(`Daily limit of ${board.dailyCap} ${board.title} calls reached. Resets 00:00 UTC.`);
  const prev = (db.prepare('SELECT MAX(locked_at) AS t FROM calls WHERE trader_id = ? AND board = ? AND locked_at <= ?').get(a.traderId, a.board, a.now) as { t: number | null }).t;
  if (prev && a.now - prev < board.minGapMin * 60_000)
    throw new CallRejected(`Wait ${Math.ceil((board.minGapMin * 60_000 - (a.now - prev)) / 60_000)} more min between ${board.title} calls.`);
}

/** Did another trader already have this exact trade open (same pair, direction, board) within the copy lag? */
export function findLeader(db: DB, traderId: number, pair: string, direction: Direction, board: BoardId, t: number): number | null {
  const r = db.prepare(`SELECT c.id FROM calls c
    WHERE c.pair = ? AND c.direction = ? AND c.board = ? AND c.trader_id != ? AND c.locked_at < ? AND c.locked_at >= ?
      AND (c.resolved_at IS NULL OR c.resolved_at > ?)
      AND (SELECT COUNT(*) FROM calls d WHERE d.trader_id = c.trader_id AND d.board = c.board AND d.status IN ('win','loss') AND d.resolved_at <= ?) >= ?
    ORDER BY c.locked_at LIMIT 1`).get(pair, direction, board, traderId, t, t - SCORING.copyLagMin * 60_000, t, t, SCORING.copyLeaderMinDecisive) as { id: number } | undefined;
  return r?.id ?? null;
}

export function insertCall(db: DB, a: {
  traderId: number; pair: string; board: BoardId; direction: Direction; bandBps: number; entry: number; bid?: number; ask?: number;
  lockedAt: number; simulated?: boolean;
}): CallRow {
  const distance = (a.entry * a.bandBps) / 1e4;
  const { target, stop } = levels({ direction: a.direction, entry: a.entry, distance });
  const salt = randomBytes(16).toString('hex');
  const hash = commitHash({ trader_id: a.traderId, board: a.board, pair: a.pair, direction: a.direction, entry: a.entry, band_bps: a.bandBps, locked_at: a.lockedAt, salt });
  const leader = findLeader(db, a.traderId, a.pair, a.direction, a.board, a.lockedAt);
  const r = db.prepare(`INSERT INTO calls (trader_id, board, pair, direction, band_bps, distance, entry, target, stop, bid, ask, locked_at, expires_at,
    copied_from, commit_hash, salt, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    a.traderId, a.board, a.pair, a.direction, a.bandBps, distance, a.entry, target, stop, a.bid ?? null, a.ask ?? null,
    a.lockedAt, a.lockedAt + BOARDS[a.board].horizonMin * 60_000, leader, hash, salt, a.simulated ? 1 : 0);
  db.prepare('UPDATE traders SET first_call_at = COALESCE(first_call_at, ?) WHERE id = ?').run(a.lockedAt, a.traderId);
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(r.lastInsertRowid) as unknown as CallRow;
}

/** Lock a live call: re-check the rules, take a fresh ticker, reject stale prices, entry = mid at exchange time. */
export async function lockCall(db: DB, a: { traderId: number; pair: string; board: BoardId; direction: Direction }): Promise<CallRow> {
  const band = loadBand(db, a.pair, a.board);
  checkCall(db, { ...a, now: Date.now(), band });
  let t: Ticker;
  try { t = await ticker(a.pair); } catch { throw new CallRejected('Could not fetch a price, try again.'); }
  if (Math.abs(t.serverTs - t.ts) > RULES.staleTickerMs || Math.abs(Date.now() - t.serverTs) > 30_000 || !(t.bid > 0 && t.ask >= t.bid))
    throw new CallRejected('Price feed is stale, call not locked. Try again.');
  return insertCall(db, { ...a, bandBps: band!.bps, entry: t.mid, bid: t.bid, ask: t.ask, lockedAt: t.serverTs });
}

export function applyOutcome(db: DB, id: number, o: NonNullable<ReturnType<typeof resolveBracket>>) {
  db.prepare("UPDATE calls SET status = ?, wash_reason = ?, exit_price = ?, resolved_at = ? WHERE id = ? AND status = 'open'")
    .run(o.status, 'reason' in o ? o.reason : null, o.exit, o.at, id);
}

/** Resolve all open live calls against fresh 1m candles. Returns the calls that just resolved. */
export async function resolveOpenCalls(db: DB): Promise<CallRow[]> {
  const open = db.prepare("SELECT * FROM calls WHERE status = 'open' AND simulated = 0").all() as unknown as CallRow[];
  const done: CallRow[] = [];
  for (const pair of new Set(open.map((c) => c.pair))) {
    let cs;
    try { cs = await candles(pair, '1m', 1000); } catch (e) { console.error(`[resolve] ${pair}: ${e}`); continue; }
    const now = Date.now() - 90_000; // finalize an expiry only once the last pre-expiry candle is complete
    for (const call of open.filter((c) => c.pair === pair)) {
      const o = resolveBracket(call, cs, now);
      if (!o) continue;
      applyOutcome(db, call.id, o);
      done.push(db.prepare('SELECT * FROM calls WHERE id = ?').get(call.id) as unknown as CallRow);
    }
  }
  return done;
}

export function fmt(x: number, ref: number) {
  const decimals = Math.max(0, 4 - Math.floor(Math.log10(Math.abs(ref))));
  return x.toFixed(Math.min(decimals, 8));
}
