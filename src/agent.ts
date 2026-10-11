import { AGENT, BOARDS, RULES, label } from './config.js';
import type { Signal } from './consensus.js';
import { getSetting, type DB } from './db.js';
import { closePosition, hasDemoKeys, placeBracket } from './executor.js';
import { candles, instrument, roundTo, ticker } from './market.js';
import { levels, pnlR, resolveBracket, type Outcome } from './resolve.js';
import { crossesWeekend } from './sessions.js';

export interface AgentTrade {
  id: number; signal_id: number | null; board: string; pair: string; direction: 'long' | 'short'; entry: number; target: number; stop: number;
  distance: number; qty: number; horizon_min: number; created_at: number; opened_at: number | null; expires_at: number;
  status: string; mode: string; risk_note: string | null; reason: string | null; order_id: string | null;
  exit_price: number | null; pnl_r: number | null; resolved_at: number | null; simulated: number;
}

const dayStart = (t: number) => Math.floor(t / 86_400_000) * 86_400_000;
export const getTrade = (db: DB, id: number) => db.prepare('SELECT * FROM agent_trades WHERE id = ?').get(id) as unknown as AgentTrade;

/** Round-trip cost as a fraction of price: two taker fills plus the spread. */
export const costFrac = (price: number, spread: number) => 2 * RULES.takerFee + spread / price;
/** Cost in R for a band: what a trade gives up before it moves. */
export const costR = (bandBps: number, spreadBps: number) => (2 * RULES.takerFee * 1e4 + spreadBps) / bandBps;

/** Paper-account equity curve from resolved agent trades: current equity, its running peak, and drawdown from peak. */
export function drawdownStatus(db: DB, simulated = 0) {
  const rows = db.prepare('SELECT pnl_r FROM agent_trades WHERE simulated = ? AND pnl_r IS NOT NULL ORDER BY resolved_at').all(simulated) as { pnl_r: number }[];
  let equity = AGENT.paperEquity, peak = equity;
  for (const r of rows) { equity += r.pnl_r * AGENT.riskUsdt; peak = Math.max(peak, equity); }
  return { equity, peak, drawdownPct: (peak - equity) / peak };
}

/** Worst case if `openCount` open trades plus one new trade all stop out with full costs. Blocks if that breaks the cap. */
export function drawdownBlock(equity: number, peak: number, openCount: number): string | null {
  const worst = (openCount + 1) * AGENT.riskUsdt * (1 + AGENT.maxCostR);
  const ddIfAllLose = (peak - (equity - worst)) / peak;
  return ddIfAllLose > AGENT.maxDrawdownPct
    ? `10% risk cap: worst case would be ${(ddIfAllLose * 100).toFixed(1)}% below peak (now ${(((peak - equity) / peak) * 100).toFixed(1)}%)`
    : null;
}

/** Risk gate. Returns a block reason or null. */
export function riskGate(db: DB, s: { pair: string; band_bps: number; board: string }, spreadBps: number, now: number): string | null {
  if (getSetting(db, 'kill') === '1') return 'kill switch is on';
  const c = costR(s.band_bps, spreadBps);
  if (c > AGENT.maxCostR) return `costs ${c.toFixed(2)}R exceed ${AGENT.maxCostR}R`;
  if (crossesWeekend(now + BOARDS[s.board as keyof typeof BOARDS].horizonMin * 60_000)) return 'would run into the weekend';
  const live = "status IN ('open','proposed') AND simulated = 0";
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM agent_trades WHERE ${live}`).get() as { n: number };
  if (n >= AGENT.maxOpen) return `max ${AGENT.maxOpen} open trades`;
  if (db.prepare(`SELECT 1 FROM agent_trades WHERE ${live} AND pair = ?`).get(s.pair)) return `already in ${label(s.pair)}`;
  const { r } = db.prepare('SELECT COALESCE(SUM(pnl_r), 0) AS r FROM agent_trades WHERE simulated = 0 AND resolved_at >= ?').get(dayStart(now)) as { r: number };
  if (r <= -AGENT.dailyLossLimitR) return `daily loss limit hit (${r.toFixed(2)}R)`;
  const dd = drawdownStatus(db);
  return drawdownBlock(dd.equity, dd.peak, n);
}

export function templateReason(s: Signal) {
  const names = s.voters.map((v) => `${v.name}${v.tier ? ` (${v.tier})` : ''}`).join(', ');
  return `${s.n_traders} qualified traders called ${label(s.pair)} ${s.direction} on the ${BOARDS[s.board].title} board within `
    + `${BOARDS[s.board].horizonMin / 4} min, carrying ${(s.agreement * 100).toFixed(0)}% of the weighted vote: ${names}. `
    + `House band ±${(s.band_bps / 100).toFixed(2)}%, 1:1, expiry ${BOARDS[s.board].horizonMin / 60}h.`;
}

/** Turn a consensus signal into a proposed (or blocked) agent trade. */
export async function propose(db: DB, s: Signal, reason = templateReason(s)): Promise<AgentTrade> {
  const now = Date.now();
  const [t, inst] = await Promise.all([ticker(s.pair), instrument(s.pair)]);
  const spreadBps = ((t.ask - t.bid) / t.mid) * 1e4;
  const block = riskGate(db, s, spreadBps, now);
  const distance = (t.mid * s.band_bps) / 1e4;
  const { target, stop } = levels({ direction: s.direction, entry: t.mid, distance });
  const qty = Math.floor(AGENT.riskUsdt / distance / inst.qtyStep) * inst.qtyStep;
  const sizeBlock = qty < inst.minQty || qty * t.mid < inst.minNotional ? `size ${qty} below exchange minimum` : null;
  const horizon = BOARDS[s.board].horizonMin;
  const r = db.prepare(`INSERT INTO agent_trades (signal_id, board, pair, direction, entry, target, stop, distance, qty, horizon_min, created_at,
    expires_at, status, mode, risk_note, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    s.id ?? null, s.board, s.pair, s.direction, t.mid, target, stop, distance, roundTo(qty, inst.qtyPrecision), horizon, now,
    now + horizon * 60_000, block || sizeBlock ? 'blocked' : 'proposed', AGENT.mode, block ?? sizeBlock, reason);
  return getTrade(db, Number(r.lastInsertRowid));
}

/** Send a proposed trade to the Bitget demo account. Entry and levels are re-stamped at execution. */
export async function execute(db: DB, id: number): Promise<AgentTrade> {
  const tr = getTrade(db, id);
  if (tr.status !== 'proposed') return tr;
  const block = getSetting(db, 'kill') === '1' ? 'kill switch is on' : !hasDemoKeys() ? 'no demo API key configured' : null;
  if (block) {
    db.prepare("UPDATE agent_trades SET status = 'blocked', risk_note = ? WHERE id = ?").run(block, id);
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
      .run(t.mid, target, stop, now, now + tr.horizon_min * 60_000, orderId, id);
  }
  return getTrade(db, id);
}

export function reject(db: DB, id: number, note: string) {
  db.prepare("UPDATE agent_trades SET status = 'rejected', risk_note = ? WHERE id = ? AND status = 'proposed'").run(note, id);
}

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
    const [cs, t] = await Promise.all([candles(tr.pair, '1m', 1000), ticker(tr.pair)]);
    const o = resolveBracket({ ...tr, locked_at: tr.opened_at! }, cs, now - 90_000);
    if (!o) continue;
    await closePosition(db, tr.pair); // TP/SL presets close wins and losses on the exchange; an expiry needs this
    settle(db, tr, o, t.ask - t.bid);
    done.push(getTrade(db, tr.id));
  }
  return done;
}
