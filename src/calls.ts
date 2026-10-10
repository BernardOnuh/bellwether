import { RULES, pairBySymbol, type Direction } from './config.js';
import type { DB } from './db.js';
import { candles, ticker, type Ticker } from './market.js';
import { loadProfile, type PairProfile } from './profile.js';
import { levels, resolveBracket } from './resolve.js';
import type { CallRow } from './scoring.js';

export class CallRejected extends Error {}

const dayStart = (t: number) => Math.floor(t / 86_400_000) * 86_400_000;

/** Rule checks that need only the DB and profile (run before and again at lock). */
export function checkCall(db: DB, a: { traderId: number; pair: string; direction: Direction; distance: number; now: number; profile?: PairProfile }) {
  const p = a.profile;
  if (!pairBySymbol(a.pair)) throw new CallRejected(`Unknown pair ${a.pair}.`);
  if (!p || a.now - p.updated_at > RULES.profileMaxAgeMs) throw new CallRejected('Pair data is out of date, try again shortly.');
  if (p.closed) throw new CallRejected(`${a.pair} looks closed (no trading in the last 30 minutes).`);
  if (!(p.band_lo <= p.band_hi)) throw new CallRejected(`${a.pair} is too quiet right now: costs exceed its typical range.`);
  if (!(a.distance >= p.band_lo && a.distance <= p.band_hi))
    throw new CallRejected(`Distance must be between ${fmt(p.band_lo, p.price)} and ${fmt(p.band_hi, p.price)} for ${a.pair}.`);
  const open = db.prepare("SELECT 1 FROM calls WHERE trader_id = ? AND pair = ? AND status = 'open'").get(a.traderId, a.pair);
  if (open) throw new CallRejected(`You already have an open call on ${a.pair}.`);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM calls WHERE trader_id = ? AND locked_at >= ?').get(a.traderId, dayStart(a.now)) as { n: number };
  if (n >= RULES.dailyCap) throw new CallRejected(`Daily cap of ${RULES.dailyCap} calls reached.`);
}

export function insertCall(db: DB, a: {
  traderId: number; pair: string; direction: Direction; distance: number; entry: number; bid?: number; ask?: number;
  lockedAt: number; profile: PairProfile; simulated?: boolean;
}): CallRow {
  const { target, stop } = levels({ direction: a.direction, entry: a.entry, distance: a.distance });
  const r = db.prepare(`INSERT INTO calls (trader_id, pair, direction, distance, entry, target, stop, bid, ask, window_min, band_ratio, locked_at, expires_at, simulated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    a.traderId, a.pair, a.direction, a.distance, a.entry, target, stop, a.bid ?? null, a.ask ?? null,
    a.profile.window_min, a.distance / a.profile.typical_range, a.lockedAt, a.lockedAt + a.profile.window_min * 60_000, a.simulated ? 1 : 0,
  );
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(r.lastInsertRowid) as unknown as CallRow;
}

/**
 * Lock a live call: re-check the rules, take a fresh ticker, reject stale prices,
 * stamp entry = mid price at the exchange's server time.
 */
export async function lockCall(db: DB, a: { traderId: number; pair: string; direction: Direction; distance: number }): Promise<CallRow> {
  const profile = loadProfile(db, a.pair);
  checkCall(db, { ...a, now: Date.now(), profile });
  let t: Ticker;
  try { t = await ticker(a.pair); } catch { throw new CallRejected('Could not fetch a price, try again.'); }
  if (Math.abs(t.serverTs - t.ts) > RULES.staleTickerMs || Math.abs(Date.now() - t.serverTs) > 30_000 || !(t.bid > 0 && t.ask >= t.bid))
    throw new CallRejected('Price feed is stale, call not locked. Try again.');
  return insertCall(db, { ...a, entry: t.mid, bid: t.bid, ask: t.ask, lockedAt: t.serverTs, profile: profile! });
}

export function applyOutcome(db: DB, id: number, o: NonNullable<ReturnType<typeof resolveBracket>>) {
  db.prepare("UPDATE calls SET status = ?, wash_reason = ?, exit_price = ?, resolved_at = ? WHERE id = ? AND status = 'open'")
    .run(o.status, 'reason' in o ? o.reason : null, o.exit, o.at, id);
}

/** Resolve all open live calls against fresh 1m candles. Returns the calls that just resolved. */
export async function resolveOpenCalls(db: DB): Promise<CallRow[]> {
  const open = db.prepare("SELECT * FROM calls WHERE status = 'open' AND simulated = 0").all() as unknown as CallRow[];
  const done: CallRow[] = [];
  const pairs = [...new Set(open.map((c) => c.pair))];
  for (const pair of pairs) {
    let cs;
    try { cs = await candles(pair, '1m', 1000); } catch (e) { console.error(`[resolve] ${pair}: ${e}`); continue; }
    // Only finalize an expiry once the last pre-expiry candle is surely complete.
    const now = Date.now() - 90_000;
    for (const call of open.filter((c) => c.pair === pair)) {
      if (cs.length && cs[0].ts > call.locked_at) console.warn(`[resolve] call ${call.id}: candle history starts after lock`);
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
