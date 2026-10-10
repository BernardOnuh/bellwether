import { AGENT } from './config.js';
import { execute, monitor, propose } from './agent.js';
import { resolveOpenCalls } from './calls.js';
import { detectConsensus, saveSignal } from './consensus.js';
import { openDb } from './db.js';
import { createBot } from './bot.js';
import { loadProfile, refreshProfiles } from './profile.js';
import { startDashboard } from './server.js';

const db = openDb();
const token = process.env.TELEGRAM_BOT_TOKEN;
const tg = token ? createBot(db, token) : null;
if (!tg) console.warn('TELEGRAM_BOT_TOKEN not set: running engine and dashboard only.');

await refreshProfiles(db);
setInterval(() => refreshProfiles(db).catch((e) => console.error('[profiles]', e)), 5 * 60_000);

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (const c of await resolveOpenCalls(db)) {
      console.log(`[call] #${c.id} ${c.pair} ${c.direction} -> ${c.status}`);
      await tg?.notifyResolved(c);
    }
    const pairs = (db.prepare("SELECT DISTINCT pair FROM calls WHERE status = 'open' AND simulated = 0").all() as { pair: string }[]).map((r) => r.pair);
    for (const pair of pairs) {
      const profile = loadProfile(db, pair);
      const s = profile && detectConsensus(db, profile, Date.now());
      if (!s) continue;
      const saved = saveSignal(db, s);
      let trade = await propose(db, saved);
      console.log(`[signal] ${s.pair} ${s.direction} n=${s.n_traders} -> trade #${trade.id} ${trade.status} ${trade.risk_note ?? ''}`);
      if (trade.status === 'proposed' && AGENT.mode === 'paper') trade = await execute(db, trade.id);
      await tg?.notifySignal(saved, trade);
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
  await tg.bot.api.setMyCommands(tg.commands);
  // Shown to new users before they tap Start, and on the bot's profile.
  await tg.bot.api.setMyDescription('Call where crypto and US stocks go next. Pick a pair, a direction and a distance; '
    + 'every call is scored against live Bitget prices. Top-ranked traders feed an AI agent that paper-trades their consensus. '
    + 'Free to play, no deposits, not financial advice.');
  await tg.bot.api.setMyShortDescription('Make market calls, get scored on real prices, climb the leaderboard.');
  tg.bot.start({ onStart: (me) => console.log(`Bot @${me.username} running`) });
}
