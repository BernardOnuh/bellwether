import { AGENT, RULES, pairBySymbol } from './config.js';
import type { Signal } from './consensus.js';
import { getSetting, type DB } from './db.js';
import { closePosition, hasDemoKeys, placeBracket } from './executor.js';
import { candles, instrument, roundTo, ticker } from './market.js';
import { levels, pnlR, resolveBracket, type Outcome } from './resolve.js';

export interface AgentTrade {
  id: number; signal_id: number | null; pair: string; direction: 'long' | 'short'; entry: number; target: number; stop: number;
  distance: number; qty: number; window_min: number; created_at: number; opened_at: number | null; expires_at: number;
  status: string; mode: string; risk_note: string | null; reason: string | null; order_id: string | null;
  exit_price: number | null; pnl_r: number | null; resolved_at: number | null; simulated: number;
}

const dayStart = (t: number) => Math.floor(t / 86_400_000) * 86_400_000;
export const getTrade = (db: DB, id: number) => db.prepare('SELECT * FROM agent_trades WHERE id = ?').get(id) as unknown as AgentTrade;

/** Risk gate: kill switch, max open trades, one trade per pair, daily loss limit. Returns a block reason or null. */
export function riskGate(db: DB, pair: string, now: number): string | null {
  if (getSetting(db, 'kill') === '1') return 'kill switch is on';
  const live = "status IN ('open','proposed') AND simulated = 0";
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM agent_trades WHERE ${live}`).get() as { n: number };
  if (n >= AGENT.maxOpen) return `max ${AGENT.maxOpen} open trades`;
  if (db.prepare(`SELECT 1 FROM agent_trades WHERE ${live} AND pair = ?`).get(pair)) return `already in ${pair}`;
  const { r } = db.prepare('SELECT COALESCE(SUM(pnl_r), 0) AS r FROM agent_trades WHERE simulated = 0 AND resolved_at >= ?').get(dayStart(now)) as { r: number };
  if (r <= -AGENT.dailyLossLimitR) return `daily loss limit hit (${r.toFixed(2)}R)`;
  return null;
}

export function templateReason(s: Signal) {
  const names = s.voters.map((v) => `${v.name} (${(v.rankScore * 100).toFixed(0)})`).join(', ');
  return `${s.n_traders} independent qualified traders called ${s.pair} ${s.direction} within ${Math.round(s.window_min * 60 / 3 / 60)}m `
    + `with ${(s.agreement * 100).toFixed(0)}% of weighted agreement: ${names}. Distance is their weighted median, `
    + `stop mirrored at 1:1, expiry ${s.window_min >= 60 ? s.window_min / 60 + 'h' : s.window_min + 'm'}.`;
}

/** Turn a consensus signal into a proposed (or blocked) agent trade. */
export async function propose(db: DB, s: Signal, reason = templateReason(s)): Promise<AgentTrade> {
  const now = Date.now();
  const block = riskGate(db, s.pair, now);
  const [t, inst] = await Promise.all([ticker(s.pair), instrument(s.pair)]);
  const { target, stop } = levels({ direction: s.direction, entry: t.mid, distance: s.distance });
  const qty = Math.floor(AGENT.riskUsdt / s.distance / inst.qtyStep) * inst.qtyStep;
  const sizeBlock = qty < inst.minQty || qty * t.mid < inst.minNotional ? `size ${qty} below exchange minimum` : null;
  const r = db.prepare(`INSERT INTO agent_trades (signal_id, pair, direction, entry, target, stop, distance, qty, window_min, created_at,
    expires_at, status, mode, risk_note, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    s.id ?? null, s.pair, s.direction, t.mid, target, stop, s.distance, roundTo(qty, inst.qtyPrecision), s.window_min, now,
    now + s.window_min * 60_000, block || sizeBlock ? 'blocked' : 'proposed', AGENT.mode, block ?? sizeBlock, reason);
  return getTrade(db, Number(r.lastInsertRowid));
}

/** Send a proposed trade to the Bitget demo account. Entry and levels are re-stamped at execution time. */
export async function execute(db: DB, id: number): Promise<AgentTrade> {
  const tr = getTrade(db, id);
  if (tr.status !== 'proposed') return tr;
  const block = getSetting(db, 'kill') === '1' ? 'kill switch is on' : null;
  if (block || !hasDemoKeys()) {
    db.prepare("UPDATE agent_trades SET status = 'blocked', risk_note = ? WHERE id = ?").run(block ?? 'no demo API key configured', id);
    return getTrade(db, id);
  }
  const [t, inst] = await Promise.all([ticker(tr.pair), instrument(tr.pair)]);
  const { target, stop } = levels({ direction: tr.direction, entry: t.mid, distance: tr.distance });
  const res = await placeBracket(db, {
    symbol: tr.pair, side: tr.direction === 'long' ? 'buy' : 'sell', qty: String(tr.qty), clientOid: `csa-${tr.id}-${Date.now()}`,
    takeProfit: roundTo(target, inst.pricePrecision).toString(), stopLoss: roundTo(stop, inst.pricePrecision).toString(),
  });
  const now = Date.now();
  if (!res.ok) {
    db.prepare("UPDATE agent_trades SET status = 'error', risk_note = ? WHERE id = ?").run(res.raw.slice(0, 300), id);
  } else {
    const orderId = (res.data as { data?: { orderId?: string } })?.data?.orderId ?? null;
    db.prepare("UPDATE agent_trades SET status = 'open', entry = ?, target = ?, stop = ?, opened_at = ?, expires_at = ?, order_id = ? WHERE id = ?")
      .run(t.mid, target, stop, now, now + tr.window_min * 60_000, orderId, id);
  }
  return getTrade(db, id);
}

export function reject(db: DB, id: number, note: string) {
  db.prepare("UPDATE agent_trades SET status = 'rejected', risk_note = ? WHERE id = ? AND status = 'proposed'").run(note, id);
}

export const costFrac = (price: number, spread: number) => 2 * RULES.takerFee + spread / price;

export function settle(db: DB, tr: AgentTrade, o: Outcome, spread: number) {
  const b = { direction: tr.direction, entry: tr.entry, distance: tr.distance, locked_at: tr.opened_at!, expires_at: tr.expires_at };
  const r = pnlR(b, o, costFrac(tr.entry, spread));
  db.prepare('UPDATE agent_trades SET status = ?, exit_price = ?, pnl_r = ?, resolved_at = ? WHERE id = ?').run(o.status, o.exit, r, o.at, tr.id);
}

/** Expire stale proposals, resolve open agent trades, flatten positions at expiry. */
export async function monitor(db: DB): Promise<AgentTrade[]> {
  const now = Date.now();
  db.prepare("UPDATE agent_trades SET status = 'rejected', risk_note = 'not confirmed in time' WHERE status = 'proposed' AND simulated = 0 AND created_at < ?")
    .run(now - AGENT.confirmTimeoutMs);
  const open = db.prepare("SELECT * FROM agent_trades WHERE status = 'open' AND simulated = 0").all() as unknown as AgentTrade[];
  const done: AgentTrade[] = [];
  for (const tr of open) {
    if (!pairBySymbol(tr.pair)) continue;
    const [cs, t] = await Promise.all([candles(tr.pair, '1m', 1000), ticker(tr.pair)]);
    const o = resolveBracket({ ...tr, locked_at: tr.opened_at! }, cs, now - 90_000);
    if (!o) continue;
    // TP/SL presets close wins and losses on the exchange; an expiry needs an explicit close.
    await closePosition(db, tr.pair);
    settle(db, tr, o, t.ask - t.bid);
    done.push(getTrade(db, tr.id));
  }
  return done;
}
