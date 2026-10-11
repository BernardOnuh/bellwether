// Drives the bot with fake Telegram updates; API calls are captured instead of sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SESSION_MODE = 'always';
const { createBot } = await import('../src/bot.js');
const { openDb } = await import('../src/db.js');
const { saveBand } = await import('../src/bands.js');

const db = openDb(':memory:');
const now = Date.now();
db.prepare('INSERT INTO quotes (pair, price, bid, ask, updated_at) VALUES (?, ?, ?, ?, ?)').run('NVDAUSDT', 230, 229.99, 230.01, now);
saveBand(db, { pair: 'NVDAUSDT', board: 'swing', bps: 113, spread_bps: 0.4, windows: 300, listed: 1, computed_at: now });
saveBand(db, { pair: 'NVDAUSDT', board: 'intraday', bps: 54, spread_bps: 0.4, windows: 300, listed: 1, computed_at: now });
saveBand(db, { pair: 'SPYUSDT', board: 'intraday', bps: 2, spread_bps: 0.4, windows: 300, listed: 0, computed_at: now });
saveBand(db, { pair: 'ORCLUSDT', board: 'd1', bps: 210, spread_bps: 3, windows: 200, listed: 1, computed_at: now });
saveBand(db, { pair: 'ORCLUSDT', board: 'd2', bps: 300, spread_bps: 3, windows: 150, listed: 1, computed_at: now });

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

test('onboarding: name, 3-step tutorial, then the menu', async () => {
  await text('/start');
  assert.match(last().text, /Welcome to Bellwether/);
  assert.deepEqual(buttons(last()), ['ob:keep', 'ob:rename']);
  await text('/call');                       // not onboarded -> intro first
  assert.match(last().text, /Welcome/);
  await tap('ob:rename');
  await text('sim_ada'); assert.match(last().text, /reserved/);
  await text('Ada Lovelace');
  assert.match(last().text, /1\/3/);
  assert.match(last().text, /NVDA is 230\.0.*takes profit at 232\.6/s);  // live example from the swing band
  await tap('ob:t1'); assert.match(last().text, /WOLF 70%/);
  await tap('ob:t2'); assert.match(last().text, /sealed/);
  await tap('ob:done'); assert.match(last().text, /You're in/);
});

test('two-tap call: stock, then Long/Short per board; the tap locks', async () => {
  await tap('m:call');
  assert.ok(buttons(last()).includes('p:NVDAUSDT'));
  await tap('p:NVDAUSDT');
  assert.deepEqual(buttons(last()).filter((b: string) => b.startsWith('k:')),
    ['k:NVDAUSDT:intraday:long', 'k:NVDAUSDT:intraday:short', 'k:NVDAUSDT:swing:long', 'k:NVDAUSDT:swing:short']);
  const labels = last().reply_markup.inline_keyboard.flat().map((b: any) => b.text);
  assert.ok(labels.includes('⬆️ Long LT ±1.13%'));
  assert.ok(labels.includes('⬇️ Short HT ±0.54%'));
  await tap('p:SPYUSDT');
  assert.match(last().text, /not listed/);
  assert.equal(buttons(last()).filter((b: string) => b.startsWith('k:')).length, 0);
  // typing a ticker opens its buttons
  await text('nvda');
  assert.ok(buttons(last()).includes('k:NVDAUSDT:swing:long'));
});

test('long-term stocks offer D1 and D2 only', async () => {
  await tap('p:ORCLUSDT');
  assert.deepEqual(buttons(last()).filter((b: string) => b.startsWith('k:')),
    ['k:ORCLUSDT:d1:long', 'k:ORCLUSDT:d1:short', 'k:ORCLUSDT:d2:long', 'k:ORCLUSDT:d2:short']);
  const labels = last().reply_markup.inline_keyboard.flat().map((b: any) => b.text);
  assert.ok(labels.includes('⬆️ Long D2 ±3.00%'));
  assert.match(last().text, /D1 expires in 24 hours, D2 expires in 48 hours/);
  await text('/call ORCL long HT');
  assert.match(last().text, /ORCL trades on D1 and D2 only/);
});

test('/pairs lists every tradable stock with HT and LT bands', async () => {
  await text('/pairs');
  assert.match(last().text, /Stocks you can trade \(30\)/);
  assert.match(last().text, /Long-term — D1 \(24h\)[\s\S]*<b>ORCL<\/b> Oracle[\s\S]*D1 ±2\.10% · D2 ±3\.00%/);
  for (const t of ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'AMD', 'MU', 'AVGO', 'PLTR', 'MSTR', 'COIN', 'QQQ', 'SPY']) assert.match(last().text, new RegExp(`<b>${t}</b>`));
  assert.match(last().text, /HT ±0\.54% · LT ±1\.13%/);
  assert.ok(buttons(last()).includes('p:SPYUSDT'));
});

test('plain-text calls: "META long LT" style', async () => {
  await text('ZZZ long lt');
  assert.match(last().text, /NOT ACCEPTED.*isn't on the list/);
  await text('spy long ht');                       // listed=0 on HT in this fixture
  assert.match(last().text, /NOT ACCEPTED<\/b> — SPY is not listed/);
  await text('orcl short ht');
  assert.match(last().text, /NOT ACCEPTED<\/b> — ORCL trades on D1 and D2 only/);
  await text('nvda');
  assert.ok(buttons(last()).includes('k:NVDAUSDT:swing:long'));
});

test('stats and leaderboard show both boards', async () => {
  await text('/stats');
  assert.match(last().text, /<b>HT<\/b>[\s\S]*<b>LT<\/b>/);
  assert.match(last().text, /8 more wins\+losses needed/);
  await text('/leaderboard');
  assert.match(last().text, /No calls yet/);
});

test('names must be unique; groups are redirected to DM', async () => {
  db.prepare("INSERT INTO traders (tg_id, name, created_at) VALUES ('999', 'Taken', 0)").run();
  await text('/name taken');
  assert.match(last().text, /taken/);
  await text('/call', { id: -100, type: 'group', title: 'g' });
  assert.match(last().text, /t\.me\/desk_bot\?start=group/);
});
