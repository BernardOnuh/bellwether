import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBracket, pnlR } from '../src/resolve.js';
import { statsFor } from '../src/scoring.js';

const M = 60_000;
const t0 = 1_000 * M + 20_000; // locked 20s into a minute
const c = (i: number, h: number, l: number, cl = (h + l) / 2) => ({ ts: 1_000 * M + i * M, o: cl, h, l, c: cl, v: 1 });
const long = { direction: 'long' as const, entry: 100, distance: 2, locked_at: t0, expires_at: t0 + 30 * M };

test('skips the lock-minute candle', () => {
  assert.equal(resolveBracket(long, [c(0, 103, 97)], t0 + M), null);
});
test('long win and loss', () => {
  assert.deepEqual(resolveBracket(long, [c(1, 101, 99), c(2, 102.1, 100)], t0 + 3 * M), { status: 'win', at: c(2, 0, 0).ts, exit: 102 });
  assert.equal(resolveBracket(long, [c(1, 101, 97.9)], t0 + 2 * M)?.status, 'loss');
});
test('short is mirrored', () => {
  const short = { ...long, direction: 'short' as const };
  assert.equal(resolveBracket(short, [c(1, 101, 97.9)], t0 + 2 * M)?.status, 'win');
  assert.equal(resolveBracket(short, [c(1, 102, 99)], t0 + 2 * M)?.status, 'loss');
});
test('both levels in one candle is an ambiguous wash', () => {
  const o = resolveBracket(long, [c(1, 102.5, 97.5)], t0 + 2 * M);
  assert.equal(o?.status, 'wash');
  assert.equal(o && 'reason' in o && o.reason, 'ambiguous');
});
test('expiry: open before, wash after; candles at/after expiry ignored', () => {
  const cs = [c(1, 101, 99, 100.5), c(31, 110, 100)];
  assert.equal(resolveBracket(long, cs, t0 + 10 * M), null);
  const o = resolveBracket(long, cs, long.expires_at);
  assert.deepEqual(o, { status: 'wash', reason: 'expired', at: long.expires_at, exit: 100.5 });
  assert.ok(Math.abs(pnlR(long, o!, 0) - 0.25) < 1e-12);
});
test('pnl in R nets costs; ambiguous counts as a loss for the agent', () => {
  assert.equal(pnlR(long, { status: 'win', at: 0, exit: 102 }, 0.002), 1 - 0.1);
  assert.equal(pnlR(long, { status: 'wash', reason: 'ambiguous', at: 0, exit: 100 }, 0), -1);
});
test('shrunk hit rate and wash penalty', () => {
  const s = statsFor(1, 'a', [
    ...Array(6).fill({ status: 'win', band_ratio: 1 }),
    ...Array(4).fill({ status: 'loss', band_ratio: 1 }),
  ]);
  assert.equal(s.hitRate, 0.6);
  assert.equal(s.shrunk, 11 / 20);
  assert.equal(s.qualified, true);
  const washer = statsFor(2, 'b', [...Array(6).fill({ status: 'win', band_ratio: 1.5 }), ...Array(4).fill({ status: 'loss', band_ratio: 1.5 }), ...Array(10).fill({ status: 'wash', band_ratio: 1.5 })], 0.2);
  assert.equal(washer.shrunk, s.shrunk);
  assert.ok(washer.rankScore < s.rankScore);
});
