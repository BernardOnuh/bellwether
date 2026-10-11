import { AGENT, BOARD_IDS, PAIRS, SESSION } from './config.js';
import { execute, monitor, propose } from './agent.js';
import { loadBand, refreshBands, refreshQuotes } from './bands.js';
import { resolveOpenCalls } from './calls.js';
import { detectConsensus, saveSignal } from './consensus.js';
import { openDb } from './db.js';
import { settleDue } from './rewards.js';
import { createBot } from './bot.js';
import { startDashboard } from './server.js';

const db = openDb();
const token = process.env.TELEGRAM_BOT_TOKEN;
const tg = token ? createBot(db, token) : null;
if (!tg) console.warn('TELEGRAM_BOT_TOKEN not set: running engine and dashboard only.');
if (SESSION.mode === 'always') console.warn('SESSION_MODE=always: market-hours calendar is OFF (demo mode).');

console.log('Calibrating house bands (first run fetches 30 days of 5m candles per stock)...');
await refreshBands(db);
setInterval(() => refreshBands(db).catch((e) => console.error('[bands]', e)), 60 * 60_000);
setInterval(() => refreshQuotes(db).catch((e) => console.error('[quotes]', e)), 30_000);

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (const c of await resolveOpenCalls(db)) {
      console.log(`[call] #${c.id} ${c.board} ${c.pair} ${c.direction} -> ${c.status}`);
      await tg?.notifyResolved(c);
    }
    const open = db.prepare("SELECT DISTINCT pair, board FROM calls WHERE status = 'open' AND simulated = 0").all() as { pair: string; board: typeof BOARD_IDS[number] }[];
    for (const { pair, board } of open) {
      const band = loadBand(db, pair, board);
      const s = band && detectConsensus(db, pair, board, Date.now(), band.bps);
      if (!s) continue;
      const saved = saveSignal(db, s);
      let trade = await propose(db, saved);
      console.log(`[signal] ${board} ${pair} ${s.direction} n=${s.n_traders} -> trade #${trade.id} ${trade.status} ${trade.risk_note ?? ''}`);
      if (trade.status === 'proposed' && AGENT.mode === 'paper') trade = await execute(db, trade.id);
      await tg?.notifySignal(saved, trade);
    }
    for (const r of settleDue(db)) {
      console.log(`[rewards] ${r.day} trader ${r.trader_id}: ${r.eligible ? `+${r.points} pts, streak ${r.streak}` : r.reason}`);
      await tg?.notifyReward(r);
    }
    for (const t of await monitor(db)) {
      console.log(`[agent] #${t.id} ${t.pair} -> ${t.status} ${t.pnl_r?.toFixed(2)}R`);
      await tg?.notifyTrade(t);
    }
  } catch (e) {
    console.error('[tick]', e);
  } finally {
    busy = false;
  }
}
setInterval(tick, 20_000);
tick();

startDashboard(Number(process.env.DASHBOARD_PORT ?? 8787));
if (tg) {
  try {
    await tg.bot.api.getMe();
  } catch (e) {
    console.error(`Telegram rejected TELEGRAM_BOT_TOKEN (${(e as Error).message}). Copy the token from @BotFather again into .env.`);
    process.exit(1);
  }
  if (!process.env.ADMIN_CHAT_ID) console.warn('ADMIN_CHAT_ID not set: send /myid to the bot, put the number in .env, restart. Until then nobody can confirm agent trades.');
  await tg.bot.api.setMyCommands(tg.commands);
  const webApp = process.env.WEBAPP_URL?.startsWith('https://') ? `${process.env.WEBAPP_URL.replace(/\/$/, '')}/app` : null;
  await tg.bot.api.setChatMenuButton({ menu_button: webApp ? { type: 'web_app', text: 'Open app', web_app: { url: webApp } } : { type: 'commands' } });
  console.log(webApp ? `Mini App: ${webApp} (chat menu button set)` : 'Mini App: set WEBAPP_URL=https://… to enable the menu button');
  await tg.bot.api.setMyDescription('Bellwether: call where US stocks go next. Pick a stock, tap long or short, and get graded against live Bitget prices. '
    + 'Earn a tier (BASE, SHARP, WOLF) on the leaderboard; the top callers lead an AI agent that paper-trades their consensus. '
    + 'Free, no deposits, not financial advice.');
  await tg.bot.api.setMyShortDescription('Call US stocks. Earn your tier. Lead the agent.');
  tg.bot.start({ onStart: (me) => console.log(`Bot @${me.username} running · ${PAIRS.length} stocks`) });
}
