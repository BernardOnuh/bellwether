import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signInitData, verifyInitData } from '../src/miniapp.js';

const TOKEN = '123456:TEST-token';
const user = JSON.stringify({ id: 555, first_name: 'Ada', username: 'ada' });

test('initData signed with the bot token verifies; tampering or another token fails', () => {
  const now = Date.now();
  const data = signInitData({ auth_date: String(Math.floor(now / 1000)), query_id: 'AAE', user }, TOKEN);
  assert.equal(verifyInitData(data, TOKEN, 86400, now)?.id, 555);
  assert.equal(verifyInitData(data, '999:other', 86400, now), null);
  assert.equal(verifyInitData(data.replace('555', '556'), TOKEN, 86400, now), null);
  assert.equal(verifyInitData('', TOKEN), null);
});

test('stale initData is rejected', () => {
  const old = Date.now() - 2 * 86400_000;
  const data = signInitData({ auth_date: String(Math.floor(old / 1000)), user }, TOKEN);
  assert.equal(verifyInitData(data, TOKEN), null);
});
