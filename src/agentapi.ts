// Bellwether HTTP API.
//   /api/public/*  no key: overview, leaderboards, trader profiles (last 5 resolved calls), market. Per-IP rate limit.
//   /api/v1/*      Bearer key:
//                    agent key (bw_…, from /apikey)        → submit and read your own calls, plus everything public
//                    data key  (bwd_…, from /requestapi)   → full resolved history of any trader, plus everything public
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BOARD_IDS, PAIRS, pairByLabel, type BoardId, type Direction } from './config.js';
import { authAgent } from './agents.js';
import { authDataKey } from './access.js';
import { CallRejected, lockCall, type CallRow } from './calls.js';
import type { DB } from './db.js';
import { market, me, publicCall } from './miniapp.js';
import { boardLeaderboard, traderHistory, traderProfile } from './profiles.js';
import { sessionLine, sessionOpen } from './sessions.js';

const LIMITS = { key: 60, ip: 120 };
const hits = new Map<string, number[]>();
function limited(who: string, perMin: number) {
  const now = Date.now(), xs = (hits.get(who) ?? []).filter((t) => now - t < 60_000);
  xs.push(now); hits.set(who, xs);
  return xs.length > perMin;
}

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(data));
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) throw new Error('body too large'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const BOARD_ALIASES: Record<string, BoardId> = { ht: 'intraday', '2h': 'intraday', intraday: 'intraday', lt: 'swing', '8h': 'swing', swing: 'swing', d1: 'd1', '24h': 'd1', d2: 'd2', '48h': 'd2' };
const boardParam = (v: string | null): 'club' | BoardId | null => (!v || v === 'club' ? 'club' : BOARD_ALIASES[v.toLowerCase()] ?? null);

function overview(db: DB) {
  const now = Date.now();
  const c = db.prepare(`SELECT COUNT(*) AS calls, SUM(status='win') AS pass, SUM(status='loss') AS failed, SUM(status='open') AS open FROM calls`).get() as Record<string, number | null>;
  const p = db.prepare(`SELECT SUM(kind='human') AS humans, SUM(kind='agent') AS agents FROM traders WHERE first_call_at IS NOT NULL`).get() as Record<string, number | null>;
  const decided = (c.pass ?? 0) + (c.failed ?? 0);
  return {
    session: { open: sessionOpen(now), line: sessionLine(now) },
    stats: { players: p.humans ?? 0, agents: p.agents ?? 0, calls: c.calls ?? 0, open: c.open ?? 0, passRate: decided ? (c.pass ?? 0) / decided : null, stocks: PAIRS.length },
    leaderboard: boardLeaderboard(db, 'club', 10, now),
    bot: 'https://t.me/BellWetherCallsbot',
  };
}

/** Public, unauthenticated reads for the website. */
async function publicApi(db: DB, req: IncomingMessage, res: ServerResponse, url: URL) {
  const ip = String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?').split(',')[0].trim();
  if (limited(`ip:${ip}`, LIMITS.ip)) return json(res, 429, { error: 'Too many requests, slow down.' });
  if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });
  const path = url.pathname;
  if (path === '/api/public/overview') return json(res, 200, overview(db));
  if (path === '/api/public/market') return json(res, 200, market(db));
  if (path === '/api/public/leaderboard') {
    const board = boardParam(url.searchParams.get('board'));
    if (!board) return json(res, 400, { error: 'board must be club, HT, LT, D1 or D2' });
    return json(res, 200, { board, rows: boardLeaderboard(db, board, Math.min(200, Number(url.searchParams.get('limit') ?? 100))) });
  }
  const t = path.match(/^\/api\/public\/traders\/(\d+)$/);
  if (t) { const p = traderProfile(db, Number(t[1])); return p ? json(res, 200, p) : json(res, 404, { error: 'trader not found' }); }
  return json(res, 404, { error: 'not found' });
}

export async function handleAgentApi(db: DB, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname.startsWith('/api/public/')) {
    try { await publicApi(db, req, res, url); } catch (e) { console.error('[api/public]', e); json(res, 500, { error: 'internal error' }); }
    return true;
  }
  if (!url.pathname.startsWith('/api/v1/')) return false;
  const agent = authAgent(db, req.headers.authorization);
  const data = agent ? null : authDataKey(db, req.headers.authorization);
  if (!agent && !data) return json(res, 401, { error: 'Missing or invalid API key. Agents: /apikey in the Bellwether bot. Data access: /requestapi.' }), true;
  if (limited(agent ? `a:${agent.id}` : `d:${data!.id}`, LIMITS.key)) return json(res, 429, { error: `Rate limit: ${LIMITS.key} requests per minute.` }), true;

  try {
    const path = url.pathname, method = req.method;
    // ---- reads available to every key ----
    if (method === 'GET' && path === '/api/v1/market') return json(res, 200, market(db)), true;
    if (method === 'GET' && path === '/api/v1/leaderboard') {
      const board = boardParam(url.searchParams.get('board'));
      if (!board) return json(res, 400, { error: 'board must be club, HT, LT, D1 or D2' }), true;
      return json(res, 200, { board, rows: boardLeaderboard(db, board, Math.min(500, Number(url.searchParams.get('limit') ?? 100))) }), true;
    }
    const prof = path.match(/^\/api\/v1\/traders\/(\d+)$/);
    if (method === 'GET' && prof) { const p = traderProfile(db, Number(prof[1])); return (p ? json(res, 200, p) : json(res, 404, { error: 'trader not found' })), true; }
    const hist = path.match(/^\/api\/v1\/traders\/(\d+)\/calls$/);
    if (method === 'GET' && hist) {
      const id = Number(hist[1]);
      if (!data && agent?.id !== id) return json(res, 403, { error: 'Full histories of other traders need a data key. Request one with /requestapi in the Bellwether bot.' }), true;
      if (!db.prepare('SELECT 1 FROM traders WHERE id = ?').get(id)) return json(res, 404, { error: 'trader not found' }), true;
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
      const before = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : undefined;
      return json(res, 200, traderHistory(db, id, limit, before)), true;
    }

    // ---- agent-only: your own calls ----
    if (!agent) return json(res, 403, { error: 'This endpoint needs an agent key (/apikey new <name> in the bot).' }), true;
    if (method === 'GET' && path === '/api/v1/me') return json(res, 200, me(db, agent.id)), true;
    if (method === 'GET' && path === '/api/v1/calls') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
      const status = url.searchParams.get('status');
      const rows = db.prepare(`SELECT * FROM calls WHERE trader_id = ? ${status === 'open' ? "AND status = 'open'" : status === 'resolved' ? "AND status != 'open'" : ''}
        ORDER BY locked_at DESC LIMIT ?`).all(agent.id, limit) as unknown as CallRow[];
      return json(res, 200, { calls: rows.map(publicCall) }), true;
    }
    const one = path.match(/^\/api\/v1\/calls\/(\d+)$/);
    if (method === 'GET' && one) {
      const c = db.prepare('SELECT * FROM calls WHERE id = ? AND trader_id = ?').get(Number(one[1]), agent.id) as unknown as CallRow | undefined;
      return (c ? json(res, 200, { call: { ...publicCall(c), salt: c.status === 'open' ? undefined : c.salt } }) : json(res, 404, { error: 'not found' })), true;
    }
    if (method === 'POST' && path === '/api/v1/calls') {
      const b = await body(req);
      const pair = pairByLabel(String(b.symbol ?? b.pair ?? ''))?.symbol;
      const board = BOARD_ALIASES[String(b.board ?? '').toLowerCase()];
      const direction = String(b.direction ?? '').toLowerCase();
      if (!pair || !board || !['long', 'short'].includes(direction))
        return json(res, 400, { accepted: false, reason: `Send {"symbol": one of ${PAIRS.map((p) => p.label).join('/')}, "direction": "long"|"short", "board": "HT"|"LT"|"D1"|"D2"}` }), true;
      try {
        const c = await lockCall(db, { traderId: agent.id, pair, board, direction: direction as Direction });
        return json(res, 201, { accepted: true, call: publicCall(c) }), true;
      } catch (e) {
        if (e instanceof CallRejected) return json(res, 422, { accepted: false, reason: e.message }), true;
        throw e;
      }
    }
    return json(res, 404, { error: 'not found' }), true;
  } catch (e) {
    console.error('[api]', e);
    return json(res, 500, { error: 'internal error' }), true;
  }
}

export { BOARD_IDS };
