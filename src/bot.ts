import { Bot, InlineKeyboard, type Context } from 'grammy';
import { AGENT, PAIRS, RULES, pairBySymbol, pairByLabel, type Direction } from './config.js';
import { execute, getTrade, reject, type AgentTrade } from './agent.js';
import { CallRejected, checkCall, fmt, lockCall } from './calls.js';
import { setSetting, getSetting, type DB } from './db.js';
import { loadProfile } from './profile.js';
import { allStats, leaderboard, type CallRow } from './scoring.js';
import type { Signal } from './consensus.js';

const BAND_STEPS = [0.5, 0.75, 1, 1.25, 1.5];
const label = (sym: string) => pairBySymbol(sym)?.label ?? sym;
const win = (m: number) => (m >= 60 ? `${m / 60}h` : `${m}m`);
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '–');

function trader(db: DB, ctx: Context) {
  const u = ctx.from!;
  const name = u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(' ');
  db.prepare('INSERT INTO traders (tg_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name')
    .run(String(u.id), name, Date.now());
  return db.prepare('SELECT id, name FROM traders WHERE tg_id = ?').get(String(u.id)) as { id: number; name: string };
}

export function describeCall(c: CallRow) {
  const icon = { open: '⏳', win: '✅', loss: '❌', wash: '➖' }[c.status];
  const tail = c.status === 'open' ? `expires ${new Date(c.expires_at).toISOString().slice(11, 16)} UTC`
    : c.status === 'wash' ? `wash (${c.wash_reason})` : c.status;
  return `${icon} #${c.id} ${label(c.pair)} ${c.direction.toUpperCase()} ±${fmt(c.distance, c.entry)} from ${fmt(c.entry, c.entry)} → ${tail}`;
}

export function describeTrade(t: AgentTrade) {
  const r = t.pnl_r !== null ? ` ${t.pnl_r >= 0 ? '+' : ''}${t.pnl_r.toFixed(2)}R` : '';
  return `🤖 Agent #${t.id} ${label(t.pair)} ${t.direction.toUpperCase()} qty ${t.qty} entry ${fmt(t.entry, t.entry)} `
    + `TP ${fmt(t.target, t.entry)} SL ${fmt(t.stop, t.entry)} [${t.status}${r}]${t.risk_note ? ` — ${t.risk_note}` : ''}`;
}

export function createBot(db: DB, token: string) {
  const bot = new Bot(token);
  const adminId = process.env.ADMIN_CHAT_ID;
  const isAdmin = (ctx: Context) => !!adminId && String(ctx.from?.id) === adminId;

  const rulesText = [
    '*How calls work*',
    'You pick the pair, the direction and a distance. The bot does the rest:',
    '• Entry: the mid price when you tap Lock, stamped by the exchange clock.',
    '• Target: your distance in your direction. Stop: the same distance against you (1:1).',
    `• Expiry: ${RULES.volatileWindowMin}m for volatile pairs, ${RULES.calmWindowMin / 60}h for calm ones (by 24h realized vol).`,
    '• Win: target hit first. Loss: stop hit first. Wash: neither by expiry, or both inside the same 1-minute candle.',
    `• Distance must sit inside the pair's band (${RULES.bandLo}x–${RULES.bandHi}x of its typical range) and above ${RULES.costMultiple}x trading costs.`,
    `• One open call per pair, ${RULES.dailyCap} calls per day.`,
    '',
    '*Ranking*: (wins + 5) / (wins + losses + 10). Washes are excluded, but a wash rate more than '
      + `${RULES.washSlack * 100} points above the crowd's lowers your rank. You need ${RULES.minDecided} wins+losses to qualify.`,
  ].join('\n');

  bot.command('start', async (ctx) => {
    trader(db, ctx);
    await ctx.reply('Welcome to the Crowd-Signal desk. /call to make a call, /rules to see how scoring works.\n\n' + rulesText, { parse_mode: 'Markdown' });
  });
  bot.command('rules', (ctx) => ctx.reply(rulesText, { parse_mode: 'Markdown' }));

  bot.command('pairs', async (ctx) => {
    const lines = PAIRS.map((p) => {
      const pr = loadProfile(db, p.symbol);
      if (!pr) return `${p.label}: no data yet`;
      const state = pr.closed ? ' (closed)' : pr.band_lo > pr.band_hi ? ' (too quiet)' : '';
      return `${p.label}${state}: ${fmt(pr.price, pr.price)} · ${pr.volatile ? 'volatile' : 'calm'} · ${win(pr.window_min)} · `
        + `distance ${fmt(pr.band_lo, pr.price)}–${fmt(pr.band_hi, pr.price)}`;
    });
    await ctx.reply(lines.join('\n'));
  });

  // /call            -> pick pair, direction, distance with buttons
  // /call BTC long 600 -> straight to the Lock button
  bot.command('call', async (ctx) => {
    const t = trader(db, ctx);
    const [p, d, dist] = ctx.match.trim().split(/\s+/);
    if (p && d && dist) {
      const pair = pairByLabel(p);
      const dir = d.toLowerCase().startsWith('l') ? 'long' : d.toLowerCase().startsWith('s') ? 'short' : null;
      if (!pair || !dir || !(Number(dist) > 0)) return ctx.reply('Usage: /call BTC long 600');
      return confirmStep(ctx, t.id, pair.symbol, dir, Number(dist));
    }
    const kb = new InlineKeyboard();
    PAIRS.forEach((pp, i) => { kb.text(pp.label, `p:${pp.symbol}`); if (i % 4 === 3) kb.row(); });
    await ctx.reply('Pick a pair:', { reply_markup: kb });
  });

  bot.callbackQuery(/^p:(\w+)$/, async (ctx) => {
    const pair = ctx.match[1];
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`${label(pair)}: which way?`, {
      reply_markup: new InlineKeyboard().text('⬆️ Long', `d:${pair}:long`).text('⬇️ Short', `d:${pair}:short`),
    });
  });

  bot.callbackQuery(/^d:(\w+):(long|short)$/, async (ctx) => {
    const [, pair, dir] = ctx.match;
    await ctx.answerCallbackQuery();
    const pr = loadProfile(db, pair);
    if (!pr) return ctx.editMessageText('No data for this pair yet, try again in a minute.');
    const kb = new InlineKeyboard();
    const steps = [...new Set(BAND_STEPS.map((k) => Number(Math.min(pr.band_hi, Math.max(pr.band_lo, k * pr.typical_range)).toPrecision(4))))]
      .filter((x) => x >= pr.band_lo && x <= pr.band_hi);
    steps.forEach((x) => kb.text(fmt(x, pr.price), `x:${pair}:${dir}:${x}`));
    await ctx.editMessageText(
      `${label(pair)} ${dir.toUpperCase()} · price ${fmt(pr.price, pr.price)} · expiry ${win(pr.window_min)}\n`
      + `Pick a distance (allowed ${fmt(pr.band_lo, pr.price)}–${fmt(pr.band_hi, pr.price)}), or type /call ${label(pair)} ${dir} <distance>`,
      { reply_markup: kb },
    );
  });

  async function confirmStep(ctx: Context, traderId: number, pair: string, dir: Direction, distance: number) {
    const pr = loadProfile(db, pair);
    try { checkCall(db, { traderId, pair, direction: dir, distance, now: Date.now(), profile: pr }); }
    catch (e) { if (e instanceof CallRejected) return ctx.reply(`🚫 ${e.message}`); throw e; }
    const text = `${label(pair)} ${dir.toUpperCase()} ±${fmt(distance, pr!.price)}, expiry ${win(pr!.window_min)}.\n`
      + 'Entry is the market price at the moment you tap Lock.';
    const kb = new InlineKeyboard().text('🔒 Lock', `l:${pair}:${dir}:${distance}`).text('Cancel', 'cancel');
    return ctx.callbackQuery ? ctx.editMessageText(text, { reply_markup: kb }) : ctx.reply(text, { reply_markup: kb });
  }

  bot.callbackQuery(/^x:(\w+):(long|short):([\d.e-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await confirmStep(ctx, trader(db, ctx).id, ctx.match[1], ctx.match[2] as Direction, Number(ctx.match[3]));
  });

  bot.callbackQuery(/^l:(\w+):(long|short):([\d.e-]+)$/, async (ctx) => {
    const t = trader(db, ctx);
    try {
      const c = await lockCall(db, { traderId: t.id, pair: ctx.match[1], direction: ctx.match[2] as Direction, distance: Number(ctx.match[3]) });
      await ctx.answerCallbackQuery({ text: 'Locked' });
      await ctx.editMessageText(`🔒 Locked at ${new Date(c.locked_at).toISOString().slice(11, 19)} UTC\n${describeCall(c)}\n`
        + `Target ${fmt(c.target, c.entry)} · Stop ${fmt(c.stop, c.entry)}`);
    } catch (e) {
      await ctx.answerCallbackQuery();
      if (e instanceof CallRejected) return ctx.editMessageText(`🚫 ${e.message}`);
      throw e;
    }
  });

  bot.callbackQuery('cancel', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText('Cancelled.'); });

  bot.command('mycalls', async (ctx) => {
    const t = trader(db, ctx);
    const rows = db.prepare('SELECT * FROM calls WHERE trader_id = ? ORDER BY locked_at DESC LIMIT 15').all(t.id) as unknown as CallRow[];
    await ctx.reply(rows.length ? rows.map(describeCall).join('\n') : 'No calls yet. /call to make one.');
  });

  bot.command('stats', async (ctx) => {
    const t = trader(db, ctx);
    const s = allStats(db).get(t.id)!;
    await ctx.reply([
      `${t.name}`,
      `Calls: ${s.calls} resolved, ${s.open} open`,
      `W/L/Wash: ${s.wins}/${s.losses}/${s.washes}`,
      `Hit rate: ${pct(s.hitRate)} · shrunk ${pct(s.shrunk)} · wash rate ${pct(s.washRate)}`,
      `Avg distance: ${Number.isFinite(s.avgBand) ? s.avgBand.toFixed(2) + 'x typical range' : '–'}`,
      s.qualified ? `Rank score ${(s.rankScore * 100).toFixed(1)}` : `${RULES.minDecided - s.wins - s.losses} more wins+losses to qualify`,
    ].join('\n'));
  });

  bot.command('leaderboard', async (ctx) => {
    const rows = leaderboard(db).slice(0, 15);
    if (!rows.length) return ctx.reply('No calls yet.');
    await ctx.reply(rows.map((s, i) =>
      `${s.qualified ? `${i + 1}.` : '·'} ${s.name} ${(s.rankScore * 100).toFixed(1)} · ${s.wins}W ${s.losses}L ${s.washes}wash · hit ${pct(s.hitRate)}`,
    ).join('\n') + `\n\n· = not yet qualified (${RULES.minDecided} wins+losses)`);
  });

  // ---- admin: agent control ----
  bot.command('kill', async (ctx) => { if (!isAdmin(ctx)) return; setSetting(db, 'kill', '1'); await ctx.reply('🛑 Kill switch ON. Agent will not open trades.'); });
  bot.command('resume', async (ctx) => { if (!isAdmin(ctx)) return; setSetting(db, 'kill', '0'); await ctx.reply('▶️ Kill switch OFF.'); });
  bot.command('agent', async (ctx) => {
    const rows = db.prepare('SELECT * FROM agent_trades WHERE simulated = 0 ORDER BY id DESC LIMIT 10').all() as unknown as AgentTrade[];
    await ctx.reply(`Mode: ${AGENT.mode} · kill switch ${getSetting(db, 'kill') === '1' ? 'ON' : 'off'}\n\n`
      + (rows.length ? rows.map(describeTrade).join('\n') : 'No agent trades yet.'));
  });

  bot.callbackQuery(/^(ok|no):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Admin only' });
    const id = Number(ctx.match[2]);
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === 'no') reject(db, id, 'rejected by human');
    const t = ctx.match[1] === 'ok' ? await execute(db, id) : getTrade(db, id);
    await ctx.editMessageText(describeTrade(t) + (t.reason ? `\n\n${t.reason}` : ''));
  });

  bot.catch((e) => console.error('[bot]', e.error));

  return {
    bot,
    async notifyResolved(c: CallRow) {
      const tg = (db.prepare('SELECT tg_id FROM traders WHERE id = ?').get(c.trader_id) as { tg_id: string | null })?.tg_id;
      if (tg) await bot.api.sendMessage(tg, describeCall(c)).catch(() => {});
    },
    async notifySignal(s: Signal, t: AgentTrade) {
      if (!adminId) return;
      const head = `📡 Consensus: ${label(s.pair)} ${s.direction.toUpperCase()} · ${s.n_traders} traders · ${pct(s.agreement)} agreement`;
      const kb = t.status === 'proposed' && t.mode === 'confirm'
        ? new InlineKeyboard().text('✅ Confirm (paper)', `ok:${t.id}`).text('✖️ Reject', `no:${t.id}`) : undefined;
      await bot.api.sendMessage(adminId, `${head}\n${describeTrade(t)}\n\n${t.reason ?? ''}`, { reply_markup: kb }).catch((e) => console.error(e));
    },
    async notifyTrade(t: AgentTrade) {
      if (adminId) await bot.api.sendMessage(adminId, describeTrade(t)).catch(() => {});
    },
  };
}
