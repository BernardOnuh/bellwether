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

test('New York day boundaries across DST', async () => {
  const { etDay, etDayEnd, prevTradingDay } = await import('../src/sessions.js');
  assert.equal(etDayEnd('2026-10-12'), Date.UTC(2026, 9, 13, 4));   // EDT
  assert.equal(etDayEnd('2026-12-01'), Date.UTC(2026, 11, 2, 5));   // EST
  assert.equal(etDay(Date.UTC(2026, 9, 13, 3, 59)), '2026-10-12');
  assert.equal(prevTradingDay('2026-10-12', 'us'), '2026-10-09');   // Monday -> Friday
});

test('daily 65% club: rolling 20, two calls today, pool split, streaks', async () => {
  const { settleDay } = await import('../src/rewards.js');
  const db = openDb(':memory:');
  for (const n of ['good', 'meh', 'lazy']) db.prepare('INSERT INTO traders (name, created_at) VALUES (?, 0)').run(n);
  const mon = Date.UTC(2026, 9, 12, 14);   // Mon 10:00 EDT
  let k = 0;
  const mk = (tr: number, t: number, st: 'win' | 'loss') => {
    const c = insertCall(db, { traderId: tr, pair: ['NVDAUSDT', 'TSLAUSDT', 'AAPLUSDT', 'MSFTUSDT'][k++ % 4], board: 'intraday', direction: 'long', bandBps: 50, entry: 100, lockedAt: t });
    applyOutcome(db, c.id, { status: st, at: t + 30 * M, exit: 100 } as never);
  };
  // history before Monday, spread over 12 days (clears the 8-day / 5-active-day warmup): good 14/20, meh 12/20, lazy 15/20
  for (let i = 0; i < 20; i++) {
    const t = mon - 12 * DAY + i * 13 * 3600_000;
    mk(1, t, i < 14 ? 'win' : 'loss'); mk(2, t + M, i < 12 ? 'win' : 'loss'); mk(3, t + 2 * M, i < 15 ? 'win' : 'loss');
  }
  // Monday: good makes 2 winning calls, meh 2 winning calls, lazy only 1
  mk(1, mon, 'win'); mk(1, mon + 3600_000, 'win');
  mk(2, mon + 60 * M, 'win'); mk(2, mon + 2 * 3600_000, 'win');
  mk(3, mon, 'win');
  const rows = new Map(settleDay(db, '2026-10-12', 'us').map((r) => [r.trader_id, r]));
  // good: last 20 = 12 old wins... rolling uses the newest 20 decisive: 14W/6L history minus oldest two (wins) + 2 wins = 14/20
  assert.equal(rows.get(1)!.eligible, 1);
  assert.equal(rows.get(1)!.points, 1000);
  assert.equal(rows.get(1)!.streak, 1);
  assert.equal(rows.get(2)!.eligible, 0);
  assert.match(rows.get(2)!.reason!, /need 13/);
  assert.equal(rows.get(3)!.eligible, 0);
  assert.match(rows.get(3)!.reason!, /need 2/);
  // Tuesday keeps the streak going
  const tue = mon + DAY;
  mk(1, tue, 'win'); mk(1, tue + 3600_000, 'loss');
  const t2 = new Map(settleDay(db, '2026-10-13', 'us').map((r) => [r.trader_id, r]));
  assert.equal(t2.get(1)!.streak, 2);
});

test('agreeing with different callers in busy moments is not copying', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 12; i++) db.prepare('INSERT INTO traders (name, created_at) VALUES (?, 0)').run(`t${i}`);
  const t0 = Date.UTC(2026, 8, 1);
  const raw = (tr: number, t: number, pair: string) =>
    db.prepare("INSERT INTO calls (trader_id, board, pair, direction, band_bps, distance, entry, target, stop, locked_at, expires_at, status, resolved_at, commit_hash, salt) VALUES (?, 'swing', ?, 'long', 100, 1, 100, 101, 99, ?, ?, 'win', ?, 'h', 's')")
      .run(tr, pair, t, t + 480 * M, t + 60 * M);
  // ten established leaders (10+ decisive each)
  for (let l = 2; l <= 11; l++) for (let i = 0; i < 10; i++) raw(l, t0 + i * DAY + l * M, 'AAPLUSDT');
  // trader 1 lands second ten times, each time behind a different leader
  for (let l = 2; l <= 11; l++) {
    const t = t0 + (20 + l) * DAY;
    raw(l, t, 'NVDAUSDT');
    const c = insertCall(db, { traderId: 1, pair: 'NVDAUSDT', board: 'swing', direction: 'long', bandBps: 100, entry: 100, lockedAt: t + 3 * M });
    applyOutcome(db, c.id, { status: 'win', at: t + 60 * M, exit: 100 } as never);
  }
  const s = boardStats(db, 'swing', t0 + 40 * DAY).get(1)!;
  assert.equal(s.copier, false);
  assert.equal(s.wins, 10);
});

test('8-day warmup before the 65% club pays', async () => {
  const { settleDay } = await import('../src/rewards.js');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO traders (name, created_at) VALUES ('fresh', 0)").run();
  const mon = Date.UTC(2026, 9, 12, 14);
  let k = 0;
  const mk = (t: number) => {
    const c = insertCall(db, { traderId: 1, pair: ['NVDAUSDT', 'TSLAUSDT', 'AAPLUSDT', 'MSFTUSDT'][k++ % 4], board: 'intraday', direction: 'long', bandBps: 50, entry: 100, lockedAt: t });
    applyOutcome(db, c.id, { status: 'win', at: t + 30 * M, exit: 100 } as never);
  };
  // 20 straight wins packed into 3 days, then 2 calls on Monday: perfect record, but still in warmup
  for (let i = 0; i < 20; i++) mk(mon - 3 * DAY + i * 3 * 3600_000);
  mk(mon); mk(mon + 3600_000);
  const r = settleDay(db, '2026-10-12', 'us')[0];
  assert.equal(r.eligible, 0);
  assert.match(r.reason!, /warmup: day 3 of 8/);
});

test('10% risk cap: worst case of all open trades + the new one stopping out stays within 10% of peak', async () => {
  const { drawdownBlock } = await import('../src/agent.js');
  // 1,000 USDT paper account, 10 USDT risk per trade, costs up to 0.25R -> 12.5 USDT worst case per trade
  assert.equal(drawdownBlock(1000, 1000, 0), null);              // 1.25% worst case
  assert.equal(drawdownBlock(1000, 1000, 2), null);              // 3 trades -> 3.75%
  assert.equal(drawdownBlock(930, 1000, 1), null);               // 7% down + 2 trades (2.5%) = 9.5%
  assert.match(drawdownBlock(930, 1000, 2)!, /10% risk cap/);    // 7% + 3.75% = 10.75% -> blocked
  assert.match(drawdownBlock(905, 1000, 0)!, /10% risk cap/);    // 9.5% + 1.25% -> blocked
  assert.equal(drawdownBlock(1100, 1150, 0), null);              // measured from the peak, not the start
});

test('long-term boards are open 24/5; HT/LT keep US hours', async () => {
  const { boardOpen } = await import('../src/sessions.js');
  const monNight = Date.UTC(2026, 9, 13, 3, 0);   // Mon 23:00 EDT
  assert.equal(boardOpen('d1', monNight, 'us'), true);
  assert.equal(boardOpen('intraday', monNight, 'us'), false);
  assert.equal(boardOpen('d2', Date.UTC(2026, 9, 12, 0, 30), 'us'), true);    // Sun 20:30 EDT: Asia open
  assert.equal(boardOpen('d2', Date.UTC(2026, 9, 11, 23, 30), 'us'), false);  // Sun 19:30 EDT
  assert.equal(boardOpen('d1', Date.UTC(2026, 9, 16, 20, 30), 'us'), false);  // Fri 16:30 EDT
});
