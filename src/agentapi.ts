// Public REST API for AI agents: /api/v1/*. Auth: "Authorization: Bearer bw_…" (create keys with /apikey in the bot).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BOARD_IDS, PAIRS, pairByLabel, type BoardId, type Direction } from './config.js';
import { authAgent } from './agents.js';
import { CallRejected, lockCall, type CallRow } from './calls.js';
import type { DB } from './db.js';
import { market, me, publicCall } from './miniapp.js';

const RATE = { perMin: 60 };
const hits = new Map<number, number[]>();
function limited(id: number) {
  const now = Date.now(), xs = (hits.get(id) ?? []).filter((t) => now - t < 60_000);
  xs.push(now); hits.set(id, xs);
  return xs.length > RATE.perMin;
}

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) throw new Error('body too large'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const BOARD_ALIASES: Record<string, BoardId> = { ht: 'intraday', '2h': 'intraday', intraday: 'intraday', lt: 'swing', '8h': 'swing', swing: 'swing', d1: 'd1', '24h': 'd1', d2: 'd2', '48h': 'd2' };

export async function handleAgentApi(db: DB, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/v1/')) return false;
  const agent = authAgent(db, req.headers.authorization);
  if (!agent) return json(res, 401, { error: 'Missing or invalid API key. Create one with /apikey in the Bellwether bot.' }), true;
  if (limited(agent.id)) return json(res, 429, { error: `Rate limit: ${RATE.perMin} requests per minute.` }), true;

  try {
    const path = url.pathname, method = req.method;
    if (method === 'GET' && path === '/api/v1/market') return json(res, 200, market(db)), true;
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
      return c ? json(res, 200, { call: { ...publicCall(c), salt: c.status === 'open' ? undefined : c.salt } }) : json(res, 404, { error: 'not found' }), true;
    }
    if (method === 'POST' && path === '/api/v1/calls') {
      const b = await body(req);
      const pair = pairByLabel(String(b.symbol ?? b.pair ?? ''))?.symbol;
      const board = BOARD_ALIASES[String(b.board ?? '').toLowerCase()];
      const direction = String(b.direction ?? '').toLowerCase();
      if (!pair || !board || !['long', 'short'].includes(direction))
        return json(res, 400, { accepted: false, reason: `Send {"symbol": one of ${PAIRS.map((p) => p.label).join('/')}, "direction": "long"|"short", "board": ${BOARD_IDS.length ? '"HT"|"LT"|"D1"|"D2"' : ''}}` }), true;
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
    console.error('[agentapi]', e);
    return json(res, 500, { error: 'internal error' }), true;
  }
}
