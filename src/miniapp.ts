// Telegram Mini App API. Every request carries Telegram's signed initData, verified with the bot token,
// so a caller can only ever act as the Telegram user who opened the app. Same DB and rules as the bot.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BOARDS, BOARD_IDS, PAIRS, REWARDS, SCORING, boardsFor, type BoardId, type Direction } from './config.js';
import { loadBand, loadQuote } from './bands.js';
import { CallRejected, lockCall, type CallRow } from './calls.js';
import type { DB } from './db.js';
import { rewardBoard, todayProgress, warmupStatus } from './rewards.js';
import { boardStats } from './scoring.js';
import { anyOpen, boardOpen, crossesWeekend, sessionLine } from './sessions.js';

export interface TgUser { id: number; first_name?: string; last_name?: string; username?: string }

/**
 * Validate Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * secret = HMAC_SHA256(key "WebAppData", bot token); hash = HMAC_SHA256(secret, sorted "k=v" lines without hash).
 */
export function verifyInitData(initData: string, botToken: string, maxAgeS = 24 * 3600, now = Date.now()): TgUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAgeS) return null;
  try {
    const user = JSON.parse(params.get('user') ?? 'null') as TgUser | null;
    return user && Number.isInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}

/** Sign initData the way Telegram does (tests and local preview only). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function traderFor(db: DB, u: TgUser) {
  const tg = String(u.id);
  let t = db.prepare('SELECT id, name, onboarded_at FROM traders WHERE tg_id = ?').get(tg) as { id: number; name: string; onboarded_at: number | null } | undefined;
  if (!t) {
    let base = (u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(' ')).slice(0, 20);
    if (base.length < 3) base = `trader${u.id % 100000}`;
    let name = base;
    for (let i = 2; db.prepare('SELECT 1 FROM traders WHERE lower(name) = lower(?)').get(name); i++) name = `${base}${i}`;
    db.prepare('INSERT INTO traders (tg_id, name, username, created_at) VALUES (?, ?, ?, ?)').run(tg, name, u.username ?? null, Date.now());
    t = db.prepare('SELECT id, name, onboarded_at FROM traders WHERE tg_id = ?').get(tg) as typeof t;
  }
  return t!;
}

const RESULT = { open: 'PENDING', win: 'PASS', loss: 'FAILED', wash: 'NO RESULT' } as const;
export const publicCall = (c: CallRow) => ({
  id: c.id, pair: c.pair, label: c.pair.replace(/USDT$/, ''), board: c.board, boardTitle: BOARDS[c.board].title, direction: c.direction,
  entry: c.entry, target: c.target, stop: c.stop, bandBps: c.band_bps, lockedAt: c.locked_at, expiresAt: c.expires_at,
  status: c.status, result: RESULT[c.status], washReason: c.wash_reason, exit: c.exit_price, resolvedAt: c.resolved_at, hash: c.commit_hash,
});

export function market(db: DB) {
  const now = Date.now();
  return {
    session: { open: anyOpen(now), line: sessionLine(now) },
    boards: BOARD_IDS.map((b) => ({ id: b, title: BOARDS[b].title, hours: BOARDS[b].hours, group: BOARDS[b].group, dailyCap: BOARDS[b].dailyCap })),
    pairs: PAIRS.map((p) => {
      const q = loadQuote(db, p.symbol);
      return {
        symbol: p.symbol, label: p.label, name: p.name, group: p.group, price: q?.price ?? null,
        boards: boardsFor(p.symbol).map((b) => {
          const x = loadBand(db, p.symbol, b);
          return { id: b, bps: x?.bps ?? null, listed: !!x?.listed, closed: !boardOpen(b, now), weekendBlocked: crossesWeekend(now + BOARDS[b].horizonMin * 60_000) };
        }),
      };
    }),
  };
}

export function me(db: DB, traderId: number) {
  const t = db.prepare('SELECT id, name, onboarded_at FROM traders WHERE id = ?').get(traderId) as { id: number; name: string; onboarded_at: number | null };
  const now = Date.now();
  const p = todayProgress(db, traderId, now);
  const standing = rewardBoard(db, now).find((r) => r.trader_id === traderId);
  const lg = league(db, traderId, now);
  const mine = lg.find((r) => r.me);
  return {
    id: t.id, name: t.name, onboarded: !!t.onboarded_at, rank: mine?.rank ?? null, players: lg.length, tier: mine?.tier ?? null,
    club: { ...p, warmupDays: REWARDS.warmupDays, warmupActiveDays: REWARDS.warmupActiveDays, minRate: REWARDS.minRate, rolling: REWARDS.rollingDecisive, minCalls: REWARDS.minCallsToday, pool: REWARDS.dailyPool,
      points7d: standing?.points7d ?? 0, pointsAll: standing?.pointsAll ?? 0, streak: standing?.streak ?? 0 },
    boards: BOARD_IDS.map((b) => {
      const s = boardStats(db, b, now).get(traderId)!;
      return { id: b, title: BOARDS[b].title, wins: s.wins, losses: s.losses, washes: s.washes, open: s.open, hitRate: s.hitRate,
        lb: s.lb, qualified: s.qualified, tier: s.tier, status: s.status, need: Math.max(0, SCORING.qualifyMinDecisive - s.decisive), copier: s.copier };
    }),
  };
}

const TIER_RANK: Record<string, number> = { WOLF: 3, SHARP: 2, BASE: 1 };

/** Best tier across boards for each trader (null = not qualified anywhere yet). */
export function bestTiers(db: DB, now = Date.now()): Map<number, string | null> {
  const best = new Map<number, string | null>();
  for (const b of BOARD_IDS) for (const s of boardStats(db, b, now).values()) {
    const cur = best.get(s.trader_id) ?? null;
    if (s.tier && (!cur || TIER_RANK[s.tier] > TIER_RANK[cur])) best.set(s.trader_id, s.tier);
    else if (!best.has(s.trader_id)) best.set(s.trader_id, null);
  }
  return best;
}

/** The league table: everyone who has called, ranked by points this week, with tier, streak, warmup and agent flag. */
export function league(db: DB, meId?: number, now = Date.now()) {
  const tiers = bestTiers(db, now);
  return rewardBoard(db, now).map((r, i) => {
    const w = warmupStatus(db, r.trader_id, now);
    return {
      rank: i + 1, id: r.trader_id, name: r.name, agent: r.kind === 'agent', demo: !!r.simulated, points7d: r.points7d, pointsAll: r.pointsAll,
      streak: r.streak, rolling: r.rolling, tier: tiers.get(r.trader_id) ?? null, warmup: !w.done, me: r.trader_id === meId,
    };
  });
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) throw new Error('body too large'); }
  return raw ? JSON.parse(raw) : {};
}

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

/** Handles /api/app/*. Returns false when the path is not ours. */
export async function handleMiniApp(db: DB, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith('/api/app/')) return false;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return json(res, 503, { error: 'bot token not configured' }), true;
  const user = verifyInitData(String(req.headers['x-telegram-init-data'] ?? ''), token);
  if (!user) return json(res, 401, { error: 'Open Bellwether from Telegram.' }), true;
  const t = traderFor(db, user);

  try {
    const route = `${req.method} ${path}`;
    if (route === 'GET /api/app/state') {
      const calls = db.prepare('SELECT * FROM calls WHERE trader_id = ? ORDER BY locked_at DESC LIMIT 30').all(t.id) as unknown as CallRow[];
      return json(res, 200, { me: me(db, t.id), market: market(db), calls: calls.map(publicCall), club: league(db, t.id) }), true;
    }
    if (route === 'POST /api/app/onboard') {
      db.prepare('UPDATE traders SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').run(Date.now(), t.id);
      return json(res, 200, { ok: true }), true;
    }
    if (route === 'POST /api/app/call') {
      const b = await body(req);
      const pair = String(b.pair ?? ''), board = String(b.board ?? '') as BoardId, direction = String(b.direction ?? '') as Direction;
      if (!PAIRS.some((p) => p.symbol === pair) || !BOARD_IDS.includes(board) || !['long', 'short'].includes(direction))
        return json(res, 400, { accepted: false, reason: 'Bad request.' }), true;
      try {
        const c = await lockCall(db, { traderId: t.id, pair, board, direction });
        db.prepare('UPDATE traders SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').run(Date.now(), t.id);
        return json(res, 200, { accepted: true, call: publicCall(c) }), true;
      } catch (e) {
        if (e instanceof CallRejected) return json(res, 200, { accepted: false, reason: e.message }), true;
        throw e;
      }
    }
    return json(res, 404, { error: 'not found' }), true;
  } catch (e) {
    console.error('[miniapp]', e);
    return json(res, 500, { error: 'Something went wrong, try again.' }), true;
  }
}
