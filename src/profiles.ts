// Public trader profiles. Anyone can see a trader's standing and their last few resolved calls;
// open calls stay sealed (hash only). Full histories need an approved data key.
import { BOARDS, BOARD_IDS, REWARDS, type BoardId } from './config.js';
import type { CallRow } from './calls.js';
import type { DB } from './db.js';
import { league } from './miniapp.js';
import { rewardBoard, warmupStatus } from './rewards.js';
import { boardStats, leaderboard } from './scoring.js';

export const PUBLIC_RECENT = 5;
const RESULT = { open: 'PENDING', win: 'PASS', loss: 'FAILED', wash: 'NO RESULT' } as const;

export const resolvedCall = (c: CallRow) => ({
  id: c.id, symbol: c.pair.replace(/USDT$/, ''), board: BOARDS[c.board].title, direction: c.direction, result: RESULT[c.status],
  entry: c.entry, target: c.target, stop: c.stop, bandBps: c.band_bps, lockedAt: c.locked_at, resolvedAt: c.resolved_at, exit: c.exit_price,
  hash: c.commit_hash, salt: c.salt,
});
export const sealedCall = (c: CallRow) => ({ id: c.id, board: BOARDS[c.board].title, lockedAt: c.locked_at, expiresAt: c.expires_at, hash: c.commit_hash, sealed: true });

export function traderProfile(db: DB, id: number, now = Date.now()) {
  const t = db.prepare('SELECT id, name, kind, simulated, created_at, first_call_at FROM traders WHERE id = ?').get(id) as
    { id: number; name: string; kind: string; simulated: number; created_at: number; first_call_at: number | null } | undefined;
  if (!t) return null;
  const lg = league(db, id, now).find((r) => r.me);
  const standing = rewardBoard(db, now).find((r) => r.trader_id === id);
  const boards = BOARD_IDS.map((b) => {
    const s = boardStats(db, b, now).get(id)!;
    return { id: b, title: BOARDS[b].title, hours: BOARDS[b].hours, wins: s.wins, losses: s.losses, washes: s.washes, open: s.open,
      hitRate: Number.isFinite(s.hitRate) ? s.hitRate : null, confidence: s.lb, tier: s.tier, status: s.status };
  }).filter((b) => b.wins + b.losses + b.washes + b.open > 0);
  const recent = db.prepare("SELECT * FROM calls WHERE trader_id = ? AND status != 'open' ORDER BY resolved_at DESC LIMIT ?").all(id, PUBLIC_RECENT) as unknown as CallRow[];
  const open = db.prepare("SELECT * FROM calls WHERE trader_id = ? AND status = 'open' ORDER BY locked_at DESC").all(id) as unknown as CallRow[];
  const { n: total } = db.prepare("SELECT COUNT(*) AS n FROM calls WHERE trader_id = ? AND status != 'open'").get(id) as { n: number };
  const w = warmupStatus(db, id, now);
  return {
    id: t.id, name: t.name, agent: t.kind === 'agent', demo: !!t.simulated, joinedAt: t.created_at, firstCallAt: t.first_call_at,
    rank: lg?.rank ?? null, tier: lg?.tier ?? null, streak: standing?.streak ?? 0,
    points7d: standing?.points7d ?? 0, pointsAll: standing?.pointsAll ?? 0, last20: standing?.rolling ?? '0/0',
    warmup: { done: w.done, days: w.days, activeDays: w.activeDays, needDays: REWARDS.warmupDays, needActiveDays: REWARDS.warmupActiveDays },
    boards,
    recent: recent.map(resolvedCall), recentLimit: PUBLIC_RECENT, resolvedTotal: total, moreAvailable: total > PUBLIC_RECENT,
    open: open.map(sealedCall),
  };
}

/** Full resolved history for data-key holders, newest first, paged by `before` (resolved_at). */
export function traderHistory(db: DB, id: number, limit = 100, before?: number) {
  const rows = db.prepare(`SELECT * FROM calls WHERE trader_id = ? AND status != 'open' ${before ? 'AND resolved_at < ?' : ''} ORDER BY resolved_at DESC LIMIT ?`)
    .all(...(before ? [id, before, limit] : [id, limit])) as unknown as CallRow[];
  return { calls: rows.map(resolvedCall), next: rows.length === limit ? rows[rows.length - 1].resolved_at : null };
}

export function boardLeaderboard(db: DB, board: 'club' | BoardId, limit = 100, now = Date.now()) {
  if (board === 'club') return league(db, undefined, now).slice(0, limit).map(({ me, ...r }) => r);
  const kinds = new Map((db.prepare('SELECT id, kind, simulated FROM traders').all() as { id: number; kind: string; simulated: number }[]).map((r) => [r.id, r]));
  return leaderboard(db, board, now).slice(0, limit).map((s, i) => ({
    rank: i + 1, id: s.trader_id, name: s.name, agent: kinds.get(s.trader_id)?.kind === 'agent', demo: !!kinds.get(s.trader_id)?.simulated, tier: s.tier, status: s.status,
    wins: s.wins, losses: s.losses, washes: s.washes, hitRate: Number.isFinite(s.hitRate) ? s.hitRate : null, confidence: s.lb,
  }));
}
