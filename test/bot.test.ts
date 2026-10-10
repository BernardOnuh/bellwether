// Drives the bot with fake Telegram updates; API calls are captured instead of sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/bot.js';
import { openDb } from '../src/db.js';
import { saveProfile } from '../src/profile.js';

const db = openDb(':memory:');
saveProfile(db, {
  pair: 'BTCUSDT', updated_at: Date.now(), price: 83000, spread: 0.1, rv24h: 0.01, volatile: 0, window_min: 480,
  typical_range: 800, band_lo: 400, band_hi: 1200, min_distance: 300, closed: 0,
});
const sent: { method: string; payload: any }[] = [];
const tg = createBot(db, 'test:token', {
  botInfo: { id: 1, is_bot: true, first_name: 'Desk', username: 'desk_bot', can_join_groups: true, can_read_all_group_messages: false,
    supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any,
});
tg.bot.api.config.use(async (_prev, method, payload) => { sent.push({ method, payload }); return { ok: true, result: true } as any; });

let uid = 1;
const user = { id: 555, is_bot: false, first_name: 'Ada', username: 'ada' };
const chat = { id: 555, type: 'private' as const, first_name: 'Ada' };
const text = (t: string, c: any = chat) => tg.bot.handleUpdate({ update_id: uid++, message: {
  message_id: uid, date: 0, chat: c, from: user, text: t,
  ...(t.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }] } : {}) } } as any);
const tap = (data: string) => tg.bot.handleUpdate({ update_id: uid++, callback_query: { id: String(uid), from: user, chat_instance: 'x', data,
  message: { message_id: 1, date: 0, chat, text: 'x' } } } as any);
const last = () => { const m = sent.filter((s) => ['sendMessage', 'editMessageText'].includes(s.method)); return m[m.length - 1].payload; };
const buttons = (p: any) => (p.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data);

test('new user onboarding: name, tutorial, first call', async () => {
  await text('/start');
  assert.match(last().text, /Welcome to the Crowd-Signal desk/);
  assert.match(last().text, /@ada/);
  assert.deepEqual(buttons(last()), ['ob:keep', 'ob:rename']);

  await text('/call');                              // not onboarded yet -> intro again
  assert.match(last().text, /Welcome/);

  await tap('ob:rename');
  assert.ok(last().reply_markup.force_reply);
  await text('sim_ada');
  assert.match(last().text, /reserved/);
  await text('ab');
  assert.match(last().text, /3–24/);
  await text('Ada Lovelace');
  const tut = sent.filter((s) => s.method === 'sendMessage').slice(-2).map((s) => s.payload.text).join('\n');
  assert.match(tut, /You're <b>Ada Lovelace<\/b>/);
  assert.match(tut, /1\/3/);
  assert.match(tut, /83,?000|83000/);              // live example uses the BTC profile

  await tap('ob:t1'); assert.match(last().text, /2\/3/);
  await tap('ob:t2'); assert.match(last().text, /3\/3/); assert.match(last().text, /demo account/);
  await tap('ob:done');
  assert.match(last().text, /You're in/);
  const row = db.prepare("SELECT name, onboarded_at FROM traders WHERE tg_id = '555'").get() as any;
  assert.equal(row.name, 'Ada Lovelace');
  assert.ok(row.onboarded_at);

  await tap('m:call');
  assert.ok(buttons(last()).includes('p:BTCUSDT'));
  await tap('p:BTCUSDT');
  assert.deepEqual(buttons(last()).slice(0, 2), ['d:BTCUSDT:long', 'd:BTCUSDT:short']);
  await tap('d:BTCUSDT:long');
  assert.deepEqual(buttons(last()).filter((b: string) => b.startsWith('x:')), ['x:BTCUSDT:long:400', 'x:BTCUSDT:long:600', 'x:BTCUSDT:long:800', 'x:BTCUSDT:long:1000', 'x:BTCUSDT:long:1200']);
  await tap('x:BTCUSDT:long:800');
  assert.match(last().text, /target ≈ 83800/);
  assert.equal(buttons(last())[0], 'l:BTCUSDT:long:800');

  await text('/call BTC long 5000');               // outside band
  assert.match(last().text, /between 400 and 1200/);
});

test('returning user gets the menu; name is not overwritten', async () => {
  await text('/start');
  assert.match(last().text, /Welcome back, <b>Ada Lovelace/);
  assert.ok(buttons(last()).includes('m:stats'));
  await text('/stats');
  assert.match(last().text, /10 more wins \+ losses to qualify/);
});

test('names must be unique; groups are redirected to DM', async () => {
  db.prepare("INSERT INTO traders (tg_id, name, created_at) VALUES ('999', 'Taken', 0)").run();
  await text('/name taken');
  assert.match(last().text, /taken/);
  await text('/call', { id: -100, type: 'group', title: 'g' });
  assert.match(last().text, /t\.me\/desk_bot\?start=group/);
});
