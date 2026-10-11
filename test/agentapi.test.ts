import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
process.env.SESSION_MODE = 'always';
const { openDb } = await import('../src/db.js');
const { createAgent, listAgents, revokeAgent } = await import('../src/agents.js');
const { handleAgentApi } = await import('../src/agentapi.js');

const db = openDb(':memory:');
const server = createServer(async (req, res) => { if (!(await handleAgentApi(db, req, res, new URL(req.url!, 'http://x')))) res.writeHead(404).end(); });
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const call = (key: string, path: string, body?: unknown) => fetch(base + path, {
  method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json() as any }));

test('agents: create, limit 3 per owner, unique names, list', () => {
  const a = createAgent(db, '42', 'alpha_bot');
  assert.ok('key' in a && a.key.startsWith('bw_') && a.agent.name === '🤖 alpha_bot');
  assert.ok('error' in createAgent(db, '42', 'alpha_bot'));
  assert.ok('error' in createAgent(db, '42', 'x'));
  createAgent(db, '42', 'beta_bot'); createAgent(db, '42', 'gamma_bot');
  assert.match((createAgent(db, '42', 'delta_bot') as { error: string }).error, /already have 3/);
  assert.equal(listAgents(db, '42').length, 3);
});

test('API: auth, validation, and the same rules as humans', async () => {
  const r = createAgent(db, '7', 'trend_bot') as { key: string };
  assert.equal((await call('bw_' + '0'.repeat(48), '/api/v1/me')).status, 401);
  const me = await call(r.key, '/api/v1/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.name, '🤖 trend_bot');
  assert.equal((await call(r.key, '/api/v1/market')).body.pairs.length, 30);
  assert.equal((await call(r.key, '/api/v1/calls', { symbol: 'NVDA', direction: 'sideways', board: 'LT' })).status, 400);
  const wrongBoard = await call(r.key, '/api/v1/calls', { symbol: 'ORCL', direction: 'long', board: 'HT' });
  assert.equal(wrongBoard.status, 422);
  assert.match(wrongBoard.body.reason, /ORCL trades on D1 and D2 only/);
  assert.deepEqual((await call(r.key, '/api/v1/calls')).body.calls, []);
});

test('revoked keys stop working', async () => {
  const r = createAgent(db, '8', 'temp_bot') as { key: string };
  assert.equal((await call(r.key, '/api/v1/me')).status, 200);
  assert.equal(revokeAgent(db, '8', 'temp_bot'), true);
  assert.equal((await call(r.key, '/api/v1/me')).status, 401);
  server.close();
});
