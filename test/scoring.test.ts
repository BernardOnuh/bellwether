import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { insertCall, applyOutcome, commitHash } from '../src/calls.js';
import { boardStats, shrunkRate, tierFor, wilson } from '../src/scoring.js';
import { crossesWeekend, etParts, sessionOpen } from '../src/sessions.js';

const DAY = 86_400_000, M = 60_000;

test('wilson bounds and the qualify gate', () => {
  // 7/8 clears a coin flip at ~90% one-sided; 5/8 does not
  assert.ok(wilson(7, 8, 1.2816, -1) > 0.5);
  assert.ok(wilson(5, 8, 1.2816, -1) < 0.5);
  // near a coin flip it takes many calls: 55% over 100 is not enough, over 400 it is
  assert.ok(wilson(55, 100, 1.2816, -1) < 0.5);
  assert.ok(wilson(220, 400, 1.2816, -1) > 0.5);
});

test('tiers use the shrunk rate, so a thin hot streak cannot be WOLF', () => {
  assert.equal(tierFor(shrunkRate(9, 12))?.name, 'SHARP');   // 75% raw -> (9+6)/(12+12) = 62.5%
  assert.equal(tierFor(shrunkRate(70, 90))?.name, 'WOLF');   // 78% raw over 90 calls stays above 70%
  assert.equal(tierFor(shrunkRate(5, 9)), null);             // 56% raw -> 52.4%, no tier
});

test('sessions: Mon–Fri 04:00–16:00 New York; no call may run into the weekend', () => {
  const t = Date.UTC(2026, 9, 12, 14, 0); // Mon 10:00 EDT
  assert.deepEqual(etParts(t), { wd: 1, min: 600 });
  assert.equal(sessionOpen(t, 'us'), true);
  assert.equal(sessionOpen(Date.UTC(2026, 9, 12, 7, 59), 'us'), false);  // 03:59 EDT
  assert.equal(sessionOpen(Date.UTC(2026, 9, 12, 20, 0), 'us'), false);  // 16:00 EDT
  assert.equal(sessionOpen(Date.UTC(2026, 9, 10, 15, 0), 'us'), false);  // Saturday
  assert.equal(crossesWeekend(Date.UTC(2026, 9, 16, 23, 59)), false);    // Fri 19:59 EDT
  assert.equal(crossesWeekend(Date.UTC(2026, 9, 17, 0, 30)), true);      // Fri 20:30 EDT
});

function setup() {
  const db = openDb(':memory:');
  for (const n of ['lead', 'copy', 'solo']) db.prepare('INSERT INTO traders (name, created_at) VALUES (?, 0)').run(n);
  return db;
}
const call = (db: ReturnType<typeof setup>, trader: number, t: number, status: 'win' | 'loss' | 'wash', pair = 'NVDAUSDT', direction: 'long' | 'short' = 'long') => {
  const c = insertCall(db, { traderId: trader, pair, board: 'swing', direction, bandBps: 100, entry: 100, lockedAt: t });
  applyOutcome(db, c.id, { status, at: t + 60 * M, exit: 100, ...(status === 'wash' ? { reason: 'expired' } : {}) } as never);
  return c;
};

test('qualification, tiers, warmup and decaying points', () => {
  const db = setup();
  const t0 = Date.UTC(2026, 8, 1);
  // 12 calls, 10 wins, during warmup (first 8 days)
  for (let i = 0; i < 12; i++) call(db, 3, t0 + i * 12 * 3600_000, i < 10 ? 'win' : 'loss');
  let s = boardStats(db, 'swing', t0 + 7 * DAY).get(3)!;
  assert.equal(s.qualified, true);
  assert.equal(s.tier, 'SHARP');            // (10+6)/(12+12) = 0.667
  assert.equal(s.warmup, true);
  assert.equal(s.points, 0);                // warmup wins pay nothing
  // after warmup, fresh wins earn points that fade over 7 days
  call(db, 3, t0 + 9 * DAY, 'win');
  s = boardStats(db, 'swing', t0 + 9 * DAY + 60 * M).get(3)!;
  assert.equal(s.warmup, false);
  assert.ok(s.points > 1.19 && s.points <= 1.2, String(s.points));   // 1.2x, barely decayed
  const later = boardStats(db, 'swing', t0 + 9 * DAY + 60 * M + 3.5 * DAY).get(3)!;
  assert.ok(Math.abs(later.points - 0.6) < 0.01);                    // half-faded
  assert.equal(boardStats(db, 'swing', t0 + 17 * DAY).get(3)!.points, 0);
});

test('habitual copier: copied wins count as losses', () => {
  const db = setup();
  const t0 = Date.UTC(2026, 8, 1);
  // leader builds 10 decisive calls first (leader eligibility), then copier follows every leader call 5 minutes later
  for (let i = 0; i < 10; i++) call(db, 1, t0 + i * DAY, 'win', 'TSLAUSDT');
  for (let i = 0; i < 10; i++) {
    const t = t0 + (20 + i) * DAY;
    db.prepare("INSERT INTO calls (trader_id, board, pair, direction, band_bps, distance, entry, target, stop, locked_at, expires_at, commit_hash, salt) VALUES (1, 'swing', 'NVDAUSDT', 'long', 100, 1, 100, 101, 99, ?, ?, 'h', 's')").run(t, t + 480 * M);
    const c = call(db, 2, t + 5 * M, 'win');
    assert.ok(c.copied_from, 'second on the same trade within 15 min is recorded');
  }
  const s = boardStats(db, 'swing', t0 + 40 * DAY).get(2)!;
  assert.equal(s.copier, true);
  assert.equal(s.wins, 0);
  assert.equal(s.losses, 10);
});

test('commit hash reveals and verifies', () => {
  const db = setup();
  const c = insertCall(db, { traderId: 3, pair: 'NVDAUSDT', board: 'intraday', direction: 'short', bandBps: 54, entry: 230.5, lockedAt: 1 });
  assert.equal(commitHash(c), c.commit_hash);
  assert.notEqual(commitHash({ ...c, direction: 'long' }), c.commit_hash);
});
