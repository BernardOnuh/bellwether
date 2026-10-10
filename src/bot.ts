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
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const HTML = { parse_mode: 'HTML' as const };

interface Trader { id: number; name: string; onboarded_at: number | null }

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

const menu = () => new InlineKeyboard()
  .text('📈 Make a call', 'm:call').text('📋 My calls', 'm:mycalls').row()
  .text('🏆 Leaderboard', 'm:leaderboard').text('📊 My stats', 'm:stats').row()
  .text('💱 Pairs', 'm:pairs').text('📖 Rules', 'm:rules');

/** Leaderboard names: 3–24 chars, letters/digits/space/_ . -, not reserved for simulated traders, unique. */
export function validateName(db: DB, name: string, selfId?: number): string | null {
  const n = name.trim();
  if (n.length < 3 || n.length > 24) return 'Names must be 3–24 characters.';
  if (!/^[\p{L}\p{N} _.\-@]+$/u.test(n)) return 'Use letters, numbers, spaces, _ . - only.';
  if (/^sim[_ -]/i.test(n)) return 'Names starting with "sim_" are reserved for simulated traders.';
  const taken = db.prepare('SELECT id FROM traders WHERE lower(name) = lower(?)').get(n) as { id: number } | undefined;
  if (taken && taken.id !== selfId) return 'That name is taken.';
  return null;
}

export function createBot(db: DB, token: string, opts: ConstructorParameters<typeof Bot>[1] = {}) {
  const bot = new Bot(token, opts);
  const adminId = process.env.ADMIN_CHAT_ID;
  const isAdmin = (ctx: Context) => !!adminId && String(ctx.from?.id) === adminId;
  const awaitingName = new Set<string>();

  // ---------- trader records ----------
  function findTrader(ctx: Context): Trader | undefined {
    return db.prepare('SELECT id, name, onboarded_at FROM traders WHERE tg_id = ?').get(String(ctx.from!.id)) as Trader | undefined;
  }
  /** Create the trader on first contact with a provisional, unique name. Never overwrites a chosen name. */
  function getTrader(ctx: Context): Trader & { isNew: boolean } {
    const u = ctx.from!;
    const existing = findTrader(ctx);
    if (existing) {
      db.prepare('UPDATE traders SET username = ? WHERE id = ?').run(u.username ?? null, existing.id);
      return { ...existing, isNew: false };
    }
    let base = (u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(' ')).slice(0, 20);
    if (validateName(db, base)?.startsWith('Use') || base.length < 3) base = `trader${u.id % 100000}`;
    let name = base;
    for (let i = 2; validateName(db, name); i++) name = `${base}${i}`;
    db.prepare('INSERT INTO traders (tg_id, name, username, created_at) VALUES (?, ?, ?, ?)').run(String(u.id), name, u.username ?? null, Date.now());
    return { ...findTrader(ctx)!, isNew: true };
  }

  // ---------- text blocks ----------
  const rulesText = () => [
    '<b>How calls work</b>',
    'You pick the pair, the direction and a distance. The bot does the rest:',
    '• <b>Entry</b>: the market price when you tap Lock, stamped by the exchange clock.',
    '• <b>Target</b>: your distance in your direction. <b>Stop</b>: the same distance against you (1:1).',
    `• <b>Expiry</b>: ${RULES.volatileWindowMin}m for volatile pairs, ${RULES.calmWindowMin / 60}h for calm ones.`,
    '• <b>Win</b>: target hit first. <b>Loss</b>: stop hit first. <b>Wash</b>: neither by expiry, or both inside the same minute.',
    `• Distance must sit inside the pair's band (see /pairs) and above ${RULES.costMultiple}x trading costs.`,
    `• One open call per pair, ${RULES.dailyCap} calls per day.`,
    '',
    '<b>Ranking</b>: (wins + 5) / (wins + losses + 10). Washes don\'t count, but washing far more often than the crowd lowers your rank. '
      + `You need ${RULES.minDecided} wins + losses to qualify.`,
  ].join('\n');

  const helpText = [
    '<b>Commands</b>',
    '/call — make a call (or <code>/call BTC long 800</code>)',
    '/mycalls — your recent calls',
    '/stats — your hit rate and rank',
    '/leaderboard — top traders',
    '/pairs — pairs, expiry windows and allowed distances',
    '/rules — how calls are scored',
    '/name — change your leaderboard name',
  ].join('\n');

  function exampleLine() {
    const pr = loadProfile(db, 'BTCUSDT');
    if (!pr) return 'Example: BTC long, distance 800 → target entry + 800, stop entry − 800.';
    const d = Number((pr.typical_range).toPrecision(2));
    return `Example right now: BTC is ${fmt(pr.price, pr.price)}. A <b>long</b> with distance <b>${fmt(d, pr.price)}</b> `
      + `targets ${fmt(pr.price + d, pr.price)} and stops at ${fmt(pr.price - d, pr.price)}, expiring in ${win(pr.window_min)}.`;
  }

  const TUTORIAL = [
    () => `<b>1/3 · Making a call</b>\n\nPick a <b>pair</b>, a <b>direction</b> (long or short) and a <b>distance</b>. `
      + 'That\'s it. Entry, stop and expiry are set for you, so nobody can cherry-pick prices.\n\n' + exampleLine(),
    () => '<b>2/3 · How you\'re scored</b>\n\n✅ target first = win · ❌ stop first = loss · ➖ neither = wash\n\n'
      + 'Rank = (wins + 5) / (wins + losses + 10), so a lucky 3-for-3 doesn\'t top the board. '
      + `You qualify after ${RULES.minDecided} wins + losses. Tiny targets are blocked, huge never-hit targets are capped, `
      + `and you get one open call per pair and ${RULES.dailyCap} per day.`,
    () => '<b>3/3 · What your calls are used for</b>\n\nWhen several top-ranked traders call the same pair the same way, '
      + 'an AI agent proposes a trade. A human confirms it, and it runs on a <b>Bitget demo account</b> (paper money).\n\n'
      + '• This is a game with no deposits. We will never ask for money, keys or passwords.\n'
      + '• Your leaderboard name and calls are visible to other players.\n'
      + '• Nothing here is financial advice.',
  ];

  // ---------- onboarding ----------
  async function startOnboarding(ctx: Context, t: Trader) {
    await ctx.reply(
      `👋 <b>Welcome to the Crowd-Signal desk!</b>\n\nCall where markets go next, get scored against real Bitget prices, `
      + 'and climb the leaderboard. The best-ranked calls feed an AI trading agent.\n\n'
      + `Your leaderboard name will be <b>${esc(t.name)}</b>.`,
      { ...HTML, reply_markup: new InlineKeyboard().text('👍 Keep this name', 'ob:keep').text('✏️ Choose another', 'ob:rename') },
    );
  }

  async function tutorialStep(ctx: Context, i: number) {
    const kb = i < TUTORIAL.length - 1 ? new InlineKeyboard().text('Next →', `ob:t${i + 1}`)
      : new InlineKeyboard().text('🚀 I\'m in', 'ob:done');
    const text = TUTORIAL[i]();
    if (ctx.callbackQuery) await ctx.editMessageText(text, { ...HTML, reply_markup: kb });
    else await ctx.reply(text, { ...HTML, reply_markup: kb });
  }

  async function askName(ctx: Context) {
    awaitingName.add(String(ctx.from!.id));
    await ctx.reply('Send me the name you want on the leaderboard (3–24 characters).', { reply_markup: { force_reply: true } });
  }

  /** Commands that need a finished onboarding call this first. */
  async function requireOnboarded(ctx: Context): Promise<Trader | null> {
    const t = getTrader(ctx);
    if (t.onboarded_at) return t;
    await ctx.reply('First, a 30-second intro.');
    await startOnboarding(ctx, t);
    return null;
  }

  // Calls are personal: keep the bot in private chats. In groups, point people to a DM.
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    if (ctx.chat && ctx.chat.type !== 'private') {
      if (ctx.message?.text?.startsWith('/')) {
        await ctx.reply(`Calls are made in private. Tap here: https://t.me/${ctx.me.username}?start=group`);
      }
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    const t = getTrader(ctx);
    awaitingName.delete(String(ctx.from!.id));
    if (!t.onboarded_at) return startOnboarding(ctx, t);
    await ctx.reply(`Welcome back, <b>${esc(t.name)}</b>. What next?`, { ...HTML, reply_markup: menu() });
  });

  bot.callbackQuery('ob:keep', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    await tutorialStep(ctx, 0);
  });
  bot.callbackQuery('ob:rename', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    await askName(ctx);
  });
  bot.callbackQuery(/^ob:t(\d)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await tutorialStep(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery('ob:done', async (ctx) => {
    const t = getTrader(ctx);
    db.prepare('UPDATE traders SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').run(Date.now(), t.id);
    await ctx.answerCallbackQuery({ text: 'Welcome aboard!' });
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`🎉 You're in, <b>${esc(t.name)}</b>. Make your first call, it takes three taps.\n\n${helpText}`, {
      ...HTML, reply_markup: new InlineKeyboard().text('📈 Make my first call', 'm:call').row().text('💱 See pairs first', 'm:pairs'),
    });
  });

  bot.command('name', async (ctx) => {
    getTrader(ctx);
    const arg = ctx.match.trim();
    if (!arg) return askName(ctx);
    return setName(ctx, arg);
  });

  async function setName(ctx: Context, name: string) {
    const t = getTrader(ctx);
    const err = validateName(db, name, t.id);
    if (err) {
      awaitingName.add(String(ctx.from!.id));
      return ctx.reply(`${err} Try another:`, { reply_markup: { force_reply: true } });
    }
    awaitingName.delete(String(ctx.from!.id));
    db.prepare('UPDATE traders SET name = ? WHERE id = ?').run(name.trim(), t.id);
    await ctx.reply(`✅ You're <b>${esc(name.trim())}</b> on the leaderboard.`, HTML);
    if (!t.onboarded_at) await tutorialStep(ctx, 0);
  }

  bot.command('help', (ctx) => ctx.reply(helpText, { ...HTML, reply_markup: menu() }));
  bot.command('rules', (ctx) => ctx.reply(rulesText(), HTML));

  // ---------- views shared by commands and menu buttons ----------
  async function showPairs(ctx: Context) {
    const lines = PAIRS.map((p) => {
      const pr = loadProfile(db, p.symbol);
      if (!pr) return `${p.label}: no data yet`;
      const state = pr.closed ? ' (closed)' : pr.band_lo > pr.band_hi ? ' (too quiet)' : '';
      return `<b>${p.label}</b>${state}: ${fmt(pr.price, pr.price)} · ${win(pr.window_min)} · distance ${fmt(pr.band_lo, pr.price)}–${fmt(pr.band_hi, pr.price)}`;
    });
    await ctx.reply(lines.join('\n'), HTML);
  }

  async function showPairPicker(ctx: Context) {
    const kb = new InlineKeyboard();
    PAIRS.forEach((pp, i) => { kb.text(pp.label, `p:${pp.symbol}`); if (i % 4 === 3) kb.row(); });
    kb.row().text('Cancel', 'cancel');
    await ctx.reply('Pick a pair:', { reply_markup: kb });
  }

  async function showMyCalls(ctx: Context, t: Trader) {
    const rows = db.prepare('SELECT * FROM calls WHERE trader_id = ? ORDER BY locked_at DESC LIMIT 15').all(t.id) as unknown as CallRow[];
    await ctx.reply(rows.length ? rows.map(describeCall).join('\n') : 'No calls yet. Tap below to make one.',
      rows.length ? {} : { reply_markup: new InlineKeyboard().text('📈 Make a call', 'm:call') });
  }

  async function showStats(ctx: Context, t: Trader) {
    const s = allStats(db).get(t.id)!;
    await ctx.reply([
      `<b>${esc(t.name)}</b>`,
      `Calls: ${s.calls} resolved, ${s.open} open`,
      `W / L / Wash: ${s.wins} / ${s.losses} / ${s.washes}`,
      `Hit rate: ${pct(s.hitRate)} · shrunk ${pct(s.shrunk)} · wash rate ${pct(s.washRate)}`,
      `Avg distance: ${Number.isFinite(s.avgBand) ? s.avgBand.toFixed(2) + 'x typical move' : '–'}`,
      s.qualified ? `Rank score <b>${(s.rankScore * 100).toFixed(1)}</b>` : `${RULES.minDecided - s.wins - s.losses} more wins + losses to qualify`,
    ].join('\n'), HTML);
  }

  async function showLeaderboard(ctx: Context) {
    const rows = leaderboard(db).slice(0, 15);
    if (!rows.length) return ctx.reply('No calls yet. Be the first!', { reply_markup: new InlineKeyboard().text('📈 Make a call', 'm:call') });
    await ctx.reply(rows.map((s, i) =>
      `${s.qualified ? `${i + 1}.` : '·'} ${esc(s.name)} ${(s.rankScore * 100).toFixed(1)} · ${s.wins}W ${s.losses}L ${s.washes}wash · hit ${pct(s.hitRate)}`,
    ).join('\n') + `\n\n· = not yet qualified (${RULES.minDecided} wins + losses)`, HTML);
  }

  // ---------- call flow ----------
  // /call             -> pick pair, direction, distance with buttons
  // /call BTC long 800 -> straight to the Lock button
  bot.command('call', async (ctx) => {
    const t = await requireOnboarded(ctx);
    if (!t) return;
    const [p, d, dist] = ctx.match.trim().split(/\s+/);
    if (p && d && dist) {
      const pair = pairByLabel(p);
      const dir = d.toLowerCase().startsWith('l') ? 'long' : d.toLowerCase().startsWith('s') ? 'short' : null;
      if (!pair || !dir || !(Number(dist) > 0)) return ctx.reply('Usage: /call BTC long 800');
      return confirmStep(ctx, t.id, pair.symbol, dir, Number(dist));
    }
    await showPairPicker(ctx);
  });

  bot.callbackQuery(/^p:(\w+)$/, async (ctx) => {
    const pair = ctx.match[1];
    await ctx.answerCallbackQuery();
    const pr = loadProfile(db, pair);
    const note = pr?.closed ? '\n⚠️ This market looks closed right now.' : '';
    await ctx.editMessageText(`${label(pair)}${pr ? ` is ${fmt(pr.price, pr.price)}` : ''}. Which way?${note}`, {
      reply_markup: new InlineKeyboard().text('⬆️ Long (up)', `d:${pair}:long`).text('⬇️ Short (down)', `d:${pair}:short`).row().text('Cancel', 'cancel'),
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
    kb.row().text('Cancel', 'cancel');
    await ctx.editMessageText(
      `${label(pair)} ${dir.toUpperCase()} · price ${fmt(pr.price, pr.price)} · expiry ${win(pr.window_min)}\n\n`
      + 'How far should price move? Smaller = hit more often but closer stop; larger = more washes.\n'
      + `Allowed ${fmt(pr.band_lo, pr.price)}–${fmt(pr.band_hi, pr.price)}, or type /call ${label(pair)} ${dir} <distance>`,
      { reply_markup: kb },
    );
  });

  async function confirmStep(ctx: Context, traderId: number, pair: string, dir: Direction, distance: number) {
    const pr = loadProfile(db, pair);
    try { checkCall(db, { traderId, pair, direction: dir, distance, now: Date.now(), profile: pr }); }
    catch (e) {
      if (!(e instanceof CallRejected)) throw e;
      return ctx.callbackQuery ? ctx.editMessageText(`🚫 ${e.message}`) : ctx.reply(`🚫 ${e.message}`);
    }
    const s = dir === 'long' ? 1 : -1;
    const text = `${label(pair)} ${dir.toUpperCase()} ±${fmt(distance, pr!.price)}, expiry ${win(pr!.window_min)}.\n`
      + `At today's price that's target ≈ ${fmt(pr!.price + s * distance, pr!.price)}, stop ≈ ${fmt(pr!.price - s * distance, pr!.price)}.\n\n`
      + 'Entry is the market price at the moment you tap Lock.';
    const kb = new InlineKeyboard().text('🔒 Lock', `l:${pair}:${dir}:${distance}`).text('Cancel', 'cancel');
    return ctx.callbackQuery ? ctx.editMessageText(text, { reply_markup: kb }) : ctx.reply(text, { reply_markup: kb });
  }

  bot.callbackQuery(/^x:(\w+):(long|short):([\d.e-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await confirmStep(ctx, getTrader(ctx).id, ctx.match[1], ctx.match[2] as Direction, Number(ctx.match[3]));
  });

  bot.callbackQuery(/^l:(\w+):(long|short):([\d.e-]+)$/, async (ctx) => {
    const t = getTrader(ctx);
    try {
      const c = await lockCall(db, { traderId: t.id, pair: ctx.match[1], direction: ctx.match[2] as Direction, distance: Number(ctx.match[3]) });
      await ctx.answerCallbackQuery({ text: 'Locked' });
      const first = (db.prepare('SELECT COUNT(*) AS n FROM calls WHERE trader_id = ?').get(t.id) as { n: number }).n === 1;
      await ctx.editMessageText(`🔒 Locked at ${new Date(c.locked_at).toISOString().slice(11, 19)} UTC\n${describeCall(c)}\n`
        + `Target ${fmt(c.target, c.entry)} · Stop ${fmt(c.stop, c.entry)}`
        + (first ? '\n\n🎉 Your first call! I\'ll message you when it resolves.' : ''));
    } catch (e) {
      await ctx.answerCallbackQuery();
      if (e instanceof CallRejected) return ctx.editMessageText(`🚫 ${e.message}`);
      throw e;
    }
  });

  bot.callbackQuery('cancel', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText('Cancelled.'); });

  bot.command('mycalls', async (ctx) => { const t = await requireOnboarded(ctx); if (t) await showMyCalls(ctx, t); });
  bot.command('stats', async (ctx) => { const t = await requireOnboarded(ctx); if (t) await showStats(ctx, t); });
  bot.command('leaderboard', showLeaderboard);
  bot.command('pairs', showPairs);

  bot.callbackQuery(/^m:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const v = ctx.match[1];
    if (v === 'pairs') return showPairs(ctx);
    if (v === 'leaderboard') return showLeaderboard(ctx);
    if (v === 'rules') return ctx.reply(rulesText(), HTML);
    const t = await requireOnboarded(ctx);
    if (!t) return;
    if (v === 'call') return showPairPicker(ctx);
    if (v === 'mycalls') return showMyCalls(ctx, t);
    if (v === 'stats') return showStats(ctx, t);
  });

  // ---------- admin: agent control ----------
  bot.command('kill', async (ctx) => { if (!isAdmin(ctx)) return; setSetting(db, 'kill', '1'); await ctx.reply('🛑 Kill switch ON. Agent will not open trades.'); });
  bot.command('resume', async (ctx) => { if (!isAdmin(ctx)) return; setSetting(db, 'kill', '0'); await ctx.reply('▶️ Kill switch OFF.'); });
  bot.command('agent', async (ctx) => {
    if (!isAdmin(ctx)) return;
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

  // Free text: a pending name, otherwise a nudge.
  bot.on('message:text', async (ctx) => {
    const id = String(ctx.from.id);
    if (awaitingName.has(id)) return setName(ctx, ctx.message.text);
    if (ctx.message.text.startsWith('/')) return ctx.reply('Unknown command.\n\n' + helpText, HTML);
    const t = getTrader(ctx);
    if (!t.onboarded_at) return startOnboarding(ctx, t);
    await ctx.reply('Tap a button or use /help.', { reply_markup: menu() });
  });

  bot.catch((e) => console.error('[bot]', e.error));

  return {
    bot,
    commands: [
      { command: 'call', description: 'Make a call: pair, direction, distance' },
      { command: 'mycalls', description: 'Your recent calls' },
      { command: 'stats', description: 'Your hit rate and rank' },
      { command: 'leaderboard', description: 'Top traders' },
      { command: 'pairs', description: 'Pairs, windows and distance bands' },
      { command: 'rules', description: 'How calls are scored' },
      { command: 'name', description: 'Change your leaderboard name' },
      { command: 'help', description: 'All commands' },
    ],
    async notifyResolved(c: CallRow) {
      const tg = (db.prepare('SELECT tg_id FROM traders WHERE id = ?').get(c.trader_id) as { tg_id: string | null })?.tg_id;
      if (!tg) return;
      const s = allStats(db).get(c.trader_id);
      const tail = s ? `\nYou: ${s.wins}W ${s.losses}L ${s.washes}wash · ${s.qualified ? `rank score ${(s.rankScore * 100).toFixed(1)}`
        : `${RULES.minDecided - s.wins - s.losses} more to qualify`}` : '';
      await bot.api.sendMessage(tg, describeCall(c) + tail, { reply_markup: new InlineKeyboard().text('📈 Call again', 'm:call') }).catch(() => {});
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
