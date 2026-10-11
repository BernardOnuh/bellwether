import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
process.env.SESSION_MODE = 'always';
const { openDb } = await import('../src/db.js');
const { insertCall, applyOutcome } = await import('../src/calls.js');
const { createAgent } = await import('../src/agents.js');
const { createRequest, approveRequest, denyRequest } = await import('../src/access.js');
const { handleAgentApi } = await import('../src/agentapi.js');

const db = openDb(':memory:');
db.prepare("INSERT INTO traders (tg_id, name, created_at) VALUES ('100', 'Ada', 0)").run();
const t0 = Date.UTC(2026, 8, 1, 14);
for (let i = 0; i < 12; i++) {
  const c = insertCall(db, { traderId: 1, pair: ['NVDAUSDT', 'TSLAUSDT', 'AAPLUSDT'][i % 3], board: 'swing', direction: 'long', bandBps: 100, entry: 100, lockedAt: t0 + i * 86_400_000 });
  applyOutcome(db, c.id, { status: i % 4 ? 'win' : 'loss', at: t0 + i * 86_400_000 + 3600_000, exit: 101 } as never);
}
insertCall(db, { traderId: 1, pair: 'METAUSDT', board: 'intraday', direction: 'short', bandBps: 70, entry: 700, lockedAt: Date.now() - 60_000 });

const server = createServer(async (req, res) => { if (!(await handleAgentApi(db, req, res, new URL(req.url!, 'http://x')))) res.writeHead(404).end(); });
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const get = (path: string, key?: string) => fetch(base + path, { headers: key ? { authorization: `Bearer ${key}` } : {} }).then(async (r) => ({ status: r.status, body: await r.json() as any }));

test('public profile: last 5 resolved calls, open calls sealed, no key needed', async () => {
  const r = await get('/api/public/traders/1');
  assert.equal(r.status, 200);
  assert.equal(r.body.recent.length, 5);
  assert.equal(r.body.resolvedTotal, 12);
  assert.equal(r.body.moreAvailable, true);
  assert.equal(r.body.open.length, 1);
  assert.equal(r.body.open[0].sealed, true);
  assert.equal(r.body.open[0].symbol, undefined);          // sealed: no stock, no direction
  assert.equal((await get('/api/public/leaderboard?board=LT')).body.rows[0].name, 'Ada');
  assert.equal((await get('/api/public/overview')).body.stats.calls, 13);
});

test('full history needs a data key; agent keys only see their own', async () => {
  const agent = createAgent(db, '200', 'peek_bot') as { key: string };
  assert.equal((await get('/api/v1/traders/1/calls', agent.key)).status, 403);
  const req = createRequest(db, '300', 'Quant Lab', 'Research on crowd forecasting accuracy') as { id: number };
  assert.ok('error' in createRequest(db, '300', 'Quant Lab', 'again please, same thing'));   // one pending at a time
  const ok = approveRequest(db, req.id)!;
  assert.match(ok.key, /^bwd_[0-9a-f]{48}$/);
  const all = await get('/api/v1/traders/1/calls?limit=100', ok.key);
  assert.equal(all.status, 200);
  assert.equal(all.body.calls.length, 12);
  assert.ok(all.body.calls[0].salt);                          // resolved calls are unsealed
  assert.equal((await get('/api/v1/me', ok.key)).status, 403);  // data keys can't act as agents
  assert.equal(approveRequest(db, req.id), null);             // can't approve twice
  const r2 = createRequest(db, '400', 'Spam', 'give me everything now') as { id: number };
  assert.equal(denyRequest(db, r2.id)?.status, 'denied');
  assert.equal((await get('/api/v1/traders/1/calls', 'bwd_' + '0'.repeat(48))).status, 401);
  server.close();
});
