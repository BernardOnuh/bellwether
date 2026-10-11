import { Bot, InlineKeyboard, type Context } from 'grammy';
import { AGENT, BOARDS, BOARD_IDS, PAIRS, REWARDS, SCORING, boardByTitle, boardsFor, label, pairBySymbol, pairByLabel, type BoardId, type Direction } from './config.js';
import { execute, getTrade, reject, type AgentTrade } from './agent.js';
import { CallRejected, fmt, lockCall, type CallRow } from './calls.js';
import { setSetting, getSetting, type DB } from './db.js';
import { loadBand, loadQuote } from './bands.js';
import { boardStats, leaderboard, TIER_BADGE, type TraderStats } from './scoring.js';
import { crossesWeekend, sessionLine, sessionOpen } from './sessions.js';
import type { Signal } from './consensus.js';
import { rewardBoard, todayProgress, type DailyReward } from './rewards.js';
import { MAX_AGENTS_PER_OWNER, createAgent, listAgents, revokeAgent } from './agents.js';

const pctN = (x: number) => `${Math.round(x * 100)}%`;
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '–');
const bandPct = (bps: number) => `±${(bps / 100).toFixed(2)}%`;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const etTime = (t: number) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit' }) + ' ET';
const short = (b: BoardId) => BOARDS[b].title;   // HT / LT
const HTML = { parse_mode: 'HTML' as const };

interface Trader { id: number; name: string; onboarded_at: number | null }

/** What a trader sees: PASS (take-profit hit), FAILED (stop hit), NO RESULT (neither in time; doesn't count). */
export const RESULT_WORD = { open: 'PENDING', win: 'PASS', loss: 'FAILED', wash: 'NO RESULT' } as const;

export function describeCall(c: CallRow) {
  const icon = { open: '⏳', win: '✅', loss: '❌', wash: '➖' }[c.status];
  const tail = c.status === 'open' ? `result at ${etTime(c.expires_at)}` : RESULT_WORD[c.status];
  return `${icon} ${label(c.pair)} ${c.direction.toUpperCase()} ${short(c.board)} ${bandPct(c.band_bps)} from ${fmt(c.entry, c.entry)} → ${tail}`;
}

export function describeTrade(t: AgentTrade) {
  const r = t.pnl_r !== null ? ` ${t.pnl_r >= 0 ? '+' : ''}${t.pnl_r.toFixed(2)}R` : '';
  return `🤖 Agent #${t.id} ${label(t.pair)} ${t.direction.toUpperCase()} ${t.horizon_min / 60}h qty ${t.qty} entry ${fmt(t.entry, t.entry)} `
    + `TP ${fmt(t.target, t.entry)} SL ${fmt(t.stop, t.entry)} [${t.status}${r}]${t.risk_note ? ` — ${t.risk_note}` : ''}`;
}

function statusLine(s: TraderStats) {
  if (s.eliminated) return '⛔ eliminated';
  const badge = s.tier ? `${TIER_BADGE[s.tier]} ${s.tier}` : s.qualified ? 'qualified, below 55%' : 'not qualified yet';
  return s.warmup && s.warmupEndsAt ? `${badge} · warmup until ${new Date(s.warmupEndsAt).toISOString().slice(0, 10)}` : badge;
}

/** Mini App URL (must be https). When set, menus get an "Open app" button and the chat menu button opens it. */
const webAppUrl = () => (process.env.WEBAPP_URL?.startsWith('https://') ? `${process.env.WEBAPP_URL.replace(/\/$/, '')}/app` : null);

const menu = () => {
  const kb = new InlineKeyboard();
  const url = webAppUrl();
  if (url) kb.webApp('📱 Open Bellwether app', url).row();
  return kb.text('📈 Make a call', 'm:call').text('📋 My calls', 'm:mycalls').row()
  .text('🏆 Leaderboard', 'm:leaderboard').text('📊 My stats', 'm:stats').row()
  .text('💹 All pairs', 'm:pairs').text('📖 Rules', 'm:rules');
};

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
  const findTrader = (ctx: Context) =>
    db.prepare('SELECT id, name, onboarded_at FROM traders WHERE tg_id = ?').get(String(ctx.from!.id)) as Trader | undefined;

  /** Create the trader on first contact with a provisional, unique name. Never overwrites a chosen name. */
  function getTrader(ctx: Context): Trader {
    const u = ctx.from!;
    const existing = findTrader(ctx);
    if (existing) {
      db.prepare('UPDATE traders SET username = ? WHERE id = ?').run(u.username ?? null, existing.id);
      return existing;
    }
    let base = (u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(' ')).slice(0, 20);
    if (base.length < 3 || validateName(db, base)?.startsWith('Use')) base = `trader${u.id % 100000}`;
    let name = base;
    for (let i = 2; validateName(db, name); i++) name = `${base}${i}`;
    db.prepare('INSERT INTO traders (tg_id, name, username, created_at) VALUES (?, ?, ?, ?)').run(String(u.id), name, u.username ?? null, Date.now());
    console.log(`[bot] new trader ${name} (telegram id ${u.id})${adminId ? '' : ' — set ADMIN_CHAT_ID to this id to make it the admin'}`);
    return findTrader(ctx)!;
  }

  // ---------- text ----------
  const rulesText = () => [
    '<b>How it works</b>',
    '• Pick a stock and tap <b>Long</b> or <b>Short</b> on one of two boards. Your tap locks the live Bitget price. No take-backs.',
    `• The house sets take-profit and stop-loss: the same distance both ways (1:1), sized to how far that stock usually moves. `
      + 'Liquid stocks: <b>HT</b> calls last 2 hours, <b>LT</b> 8 hours. Long-term stocks: <b>D1</b> calls last 24 hours, <b>D2</b> 48 hours.',
    '• ✅ take-profit first = win · ❌ stop first = loss · ➖ neither by expiry = wash (doesn\'t count).',
    '• Calls open Mon–Fri 04:00–16:00 New York time, and no call may run into the weekend (so D1 closes Thursday, D2 Wednesday).',
    `• Limits per day: ${BOARD_IDS.map((b) => `${BOARDS[b].title} ${BOARDS[b].dailyCap} (${BOARDS[b].minGapMin >= 60 ? BOARDS[b].minGapMin / 60 + 'h' : BOARDS[b].minGapMin + ' min'} apart)`).join(' · ')}. One open call per stock per board.`,
    '',
    `<b>🏆 Daily rewards — the ${pctN(REWARDS.minRate)} club</b>`,
    `• <b>Warmup first:</b> your first ${REWARDS.warmupDays} days (with calls on ${REWARDS.warmupActiveDays}+ trading days) build your record but earn nothing. Then the main game starts.`,
    `• Every trading day at midnight New York, you earn a share of <b>${REWARDS.dailyPool.toLocaleString()} points</b> if your last `
      + `${REWARDS.rollingDecisive} wins+losses are at least ${pctN(REWARDS.minRate)} wins (${Math.ceil(REWARDS.minRate * REWARDS.rollingDecisive)} of ${REWARDS.rollingDecisive}) `
      + `and you made at least ${REWARDS.minCallsToday} calls that day.`,
    '• The pool is split by that day\'s wins × your tier. Points nobody earns are burned. Keep qualifying to build a 🔥 streak.',
    '',
    '<b>Tiers</b> (each board separately)',
    `• <b>Qualify</b>: ${SCORING.qualifyMinDecisive}+ wins+losses and 90% statistical confidence you beat a coin flip. Luck doesn't qualify.`,
    '• <b>Tiers</b> on your hit rate (pulled toward 50% for small samples): ✅ BASE 55% 1× · 🎯 SHARP 60% 1.2× · 🐺 WOLF 70% 2×.',
    '• <b>Copying</b>: habitually opening the same trade minutes after someone else turns your copied wins into losses.',
    `• <b>Elimination</b>: after ${SCORING.elimMinDecisive}+ calls, a hit rate confidently below 45% removes you from the board.`,
    '',
    '🔒 Open calls are sealed: others see only a fingerprint until they resolve.',
  ].join('\n');

  const helpText = [
    'Just type a call: <code>META long LT</code> · <code>ORCL short D2</code> · <code>NVDA buy HT</code>',
    'You get ✅ ACCEPTED now, then ✅ PASS or ❌ FAILED when it resolves.',
    '',
    '<b>Commands</b>',
    '/pairs — all stocks you can trade, with prices and bands',
    '/call — make a call (or <code>/call NVDA long LT</code>, <code>/call ORCL short D2</code>)',
    '/mycalls — your recent calls',
    '/stats — your tier, points and progress',
    '/leaderboard — daily rewards: the 65% club',
    '/tiers — tiers on each board',
    '/rules — how scoring works',
    '/name — change your leaderboard name',
    '/apikey — let your own AI agent submit calls',
  ].join('\n');

  function exampleLine() {
    const q = loadQuote(db, 'NVDAUSDT'), b = loadBand(db, 'NVDAUSDT', 'swing');
    if (!q || !b) return 'Example: NVDA long LT → take-profit about 1% above entry, stop 1% below, 8 hours to get there.';
    const d = (q.price * b.bps) / 1e4;
    return `Example right now: NVDA is ${fmt(q.price, q.price)}. A <b>long LT</b> call takes profit at ${fmt(q.price + d, q.price)} `
      + `and stops at ${fmt(q.price - d, q.price)} (${bandPct(b.bps)}), with 8 hours to get there.`;
  }

  const TUTORIAL = [
    () => '<b>1/3 · Making a call</b>\n\nPick a stock, then tap <b>Long</b> (up) or <b>Short</b> (down) on the '
      + '<b>HT</b> (2 hours) or <b>LT</b> (8 hours). Long-term stocks use <b>D1</b> (24 hours) and <b>D2</b> (48 hours). That\'s it: two taps.\n\n'
      + 'Your tap locks the live price. The house sets take-profit and stop at the same distance, so every call is an equal test of skill.\n\n'
      + exampleLine(),
    () => '<b>2/3 · How you earn</b>\n\n✅ take-profit first = win · ❌ stop first = loss · ➖ neither = wash (doesn\'t count)\n\n'
      + `🏆 <b>Daily rewards:</b> keep your last ${REWARDS.rollingDecisive} wins+losses at <b>${pctN(REWARDS.minRate)} or better</b> `
      + `and make ${REWARDS.minCallsToday}+ calls a day, and you share ${REWARDS.dailyPool.toLocaleString()} points every trading day. `
      + 'Qualify day after day for a 🔥 streak.\n\n'
      + `🌱 <b>Warmup:</b> your first ${REWARDS.warmupDays} days, with calls on ${REWARDS.warmupActiveDays}+ trading days, build your record before the main game.\n\n`
      + 'Your hit rate also sets a tier that boosts your share: ✅ BASE 55% · 🎯 SHARP 60% · 🐺 WOLF 70% (2×).',
    () => '<b>3/3 · What your calls power</b>\n\nWhen several top-tier traders call the same stock the same way, an AI agent '
      + 'proposes that trade. A human confirms it, and it runs on a <b>Bitget demo account</b> (paper money).\n\n'
      + '• 🔒 Your open calls are sealed. Nobody can copy them live, and copying others doesn\'t pay.\n'
      + '• 🕓 Calls open Mon–Fri 04:00–16:00 New York time.\n'
      + '• No deposits. We will never ask for money, keys or passwords. Not financial advice.',
  ];

  // ---------- onboarding ----------
  async function startOnboarding(ctx: Context, t: Trader) {
    await ctx.reply(
      '🔔 <b>Welcome to Bellwether!</b>\n\nCall where US stocks go next, get graded against live Bitget prices, '
      + 'and earn a tier on the leaderboard. The best callers steer an AI trading agent.\n\n'
      + `Your leaderboard name will be <b>${esc(t.name)}</b>.`,
      { ...HTML, reply_markup: new InlineKeyboard().text('👍 Keep this name', 'ob:keep').text('✏️ Choose another', 'ob:rename') },
    );
  }

  async function tutorialStep(ctx: Context, i: number) {
    const kb = i < TUTORIAL.length - 1 ? new InlineKeyboard().text('Next →', `ob:t${i + 1}`) : new InlineKeyboard().text('🚀 I\'m in', 'ob:done');
    if (ctx.callbackQuery) await ctx.editMessageText(TUTORIAL[i](), { ...HTML, reply_markup: kb });
    else await ctx.reply(TUTORIAL[i](), { ...HTML, reply_markup: kb });
  }

  async function askName(ctx: Context) {
    awaitingName.add(String(ctx.from!.id));
    await ctx.reply('Send me the name you want on the leaderboard (3–24 characters).', { reply_markup: { force_reply: true } });
  }

  async function requireOnboarded(ctx: Context): Promise<Trader | null> {
    const t = getTrader(ctx);
    if (t.onboarded_at) return t;
    await ctx.reply('First, a 30-second intro.');
    await startOnboarding(ctx, t);
    return null;
  }

  // Calls are personal: keep the bot in private chats.
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    if (ctx.chat && ctx.chat.type !== 'private') {
      if (ctx.message?.text?.startsWith('/')) await ctx.reply(`Calls are made in private. Tap here: https://t.me/${ctx.me.username}?start=group`);
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    const t = getTrader(ctx);
    awaitingName.delete(String(ctx.from!.id));
    if (!t.onboarded_at) return startOnboarding(ctx, t);
    await ctx.reply(`Welcome back, <b>${esc(t.name)}</b>.\n${sessionLine(Date.now())}`, { ...HTML, reply_markup: menu() });
  });

  bot.callbackQuery('ob:keep', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageReplyMarkup(); await tutorialStep(ctx, 0); });
  bot.callbackQuery('ob:rename', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageReplyMarkup(); await askName(ctx); });
  bot.callbackQuery(/^ob:t(\d)$/, async (ctx) => { await ctx.answerCallbackQuery(); await tutorialStep(ctx, Number(ctx.match[1])); });
  bot.callbackQuery('ob:done', async (ctx) => {
    const t = getTrader(ctx);
    db.prepare('UPDATE traders SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').run(Date.now(), t.id);
    await ctx.answerCallbackQuery({ text: 'Welcome aboard!' });
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`🎉 You're in, <b>${esc(t.name)}</b>.\n${sessionLine(Date.now())}\n\n${helpText}`, {
      ...HTML, reply_markup: new InlineKeyboard().text('📈 Make my first call', 'm:call').row().text('💹 See all pairs', 'm:pairs'),
    });
  });

  bot.command('name', async (ctx) => {
    getTrader(ctx);
    const arg = ctx.match.trim();
    return arg ? setName(ctx, arg) : askName(ctx);
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

  bot.command('myid', (ctx) => ctx.reply(`Your Telegram id is <code>${ctx.from!.id}</code>.`
    + (adminId ? (isAdmin(ctx) ? ' You are the admin.' : '') : '\nPut it in ADMIN_CHAT_ID in .env and restart to become the admin.'), HTML));
  // ---------- AI agents ----------
  // /apikey               -> list your agents
  // /apikey new <name>    -> create an agent and show its API key once
  // /apikey revoke <name> -> disable an agent's key (its record stays)
  bot.command('apikey', async (ctx) => {
    const owner = String(ctx.from!.id);
    const [sub, ...rest] = ctx.match.trim().split(/\s+/).filter(Boolean);
    const base = (process.env.WEBAPP_URL || `http://localhost:${process.env.DASHBOARD_PORT ?? 8787}`).replace(/\/$/, '');
    if (sub === 'new') {
      const r = createAgent(db, owner, rest.join(' '));
      if ('error' in r) return ctx.reply(`🚫 ${esc(r.error)}`, HTML);
      return ctx.reply([
        `🤖 <b>${esc(r.agent.name)}</b> created. Its API key (shown once, keep it secret):`,
        `<code>${r.key}</code>`,
        '',
        `Submit a call:\n<code>curl -X POST ${base}/api/v1/calls -H "Authorization: Bearer ${r.key.slice(0, 10)}…" -H "content-type: application/json" -d '{"symbol":"NVDA","direction":"long","board":"LT"}'</code>`,
        '',
        `Same rules as humans: market hours, caps, sealing, an ${REWARDS.warmupDays}-day warmup, then the ${pctN(REWARDS.minRate)} club. Docs: AGENT_API.md in the repo.`,
      ].join('\n'), HTML);
    }
    if (sub === 'revoke') {
      return ctx.reply(revokeAgent(db, owner, rest.join(' ')) ? '✅ Key revoked. The agent\'s record stays on the board.' : 'No active agent with that name.');
    }
    const agents = listAgents(db, owner);
    await ctx.reply([
      `<b>Your AI agents</b> (${agents.filter((a) => !a.revoked_at).length}/${MAX_AGENTS_PER_OWNER})`,
      ...(agents.length ? agents.map((a) => `${a.revoked_at ? '⛔' : '🟢'} ${esc(a.name)} · key ${a.api_key_prefix}… · ${a.first_call_at ? `first call ${new Date(a.first_call_at).toISOString().slice(0, 10)}` : 'no calls yet'}`) : ['None yet.']),
      '',
      'Create one: <code>/apikey new my_bot</code>',
      'Revoke: <code>/apikey revoke my_bot</code>',
    ].join('\n'), HTML);
  });

  bot.command('help', (ctx) => ctx.reply(helpText, { ...HTML, reply_markup: menu() }));
  bot.command('rules', (ctx) => ctx.reply(rulesText(), HTML));

  // ---------- views ----------
  /** Every stock you can trade, grouped by the boards it trades on, with live price and band per board. */
  async function showPairs(ctx: Context) {
    const line = (symbol: string) => {
      const p = pairBySymbol(symbol)!, q = loadQuote(db, symbol);
      const bands = boardsFor(symbol).map((b) => { const x = loadBand(db, symbol, b); return `${short(b)} ${x?.listed ? bandPct(x.bps) : '—'}`; });
      return `<b>${p.label}</b> ${esc(p.name)} · ${q ? fmt(q.price, q.price) : '…'}\n   ${bands.join(' · ')}`;
    };
    const group = (g: 'liquid' | 'long') => PAIRS.filter((p) => p.group === g).map((p) => line(p.symbol)).join('\n');
    await ctx.reply(`<b>Stocks you can trade (${PAIRS.length})</b>\n${sessionLine(Date.now())}\n\n`
      + `<b>⚡ Liquid — HT (2h) · LT (8h)</b>\n${group('liquid')}\n\n<b>🕰 Long-term — D1 (24h) · D2 (48h)</b>\n${group('long')}\n\n`
      + '± is the take-profit and stop distance, recalibrated daily. Tap a stock to call it:',
      { ...HTML, reply_markup: pairKeyboard() });
  }

  const pairKeyboard = () => {
    const kb = new InlineKeyboard();
    PAIRS.forEach((pp, i) => { kb.text(pp.label, `p:${pp.symbol}`); if (i % 5 === 4) kb.row(); });
    return kb;
  };

  async function showPairPicker(ctx: Context) {
    const now = Date.now();
    if (!sessionOpen(now)) return ctx.reply(`${sessionLine(now)}\n\nMeanwhile: /leaderboard · /stats · /board`);
    const kb = pairKeyboard().row().text('📋 All pairs with prices', 'm:pairs').text('Cancel', 'cancel');
    const names = (g: 'liquid' | 'long') => PAIRS.filter((p) => p.group === g).map((p) => p.label).join(' ');
    await ctx.reply(`${sessionLine(now)}\n\n⚡ HT/LT: ${names('liquid')}\n🕰 D1/D2: ${names('long')}\n\nPick a stock:`, { reply_markup: kb });
  }

  async function showDirection(ctx: Context, pair: string) {
    const now = Date.now();
    const q = loadQuote(db, pair);
    const kb = new InlineKeyboard();
    const notes: string[] = [];
    for (const b of boardsFor(pair)) {
      const band = loadBand(db, pair, b);
      if (!band?.listed) { notes.push(`${BOARDS[b].title}: not listed for ${label(pair)}.`); continue; }
      if (crossesWeekend(now + BOARDS[b].horizonMin * 60_000)) { notes.push(`${BOARDS[b].title}: would run into the weekend.`); continue; }
      kb.text(`⬆️ Long ${short(b)} ${bandPct(band.bps)}`, `k:${pair}:${b}:long`).text(`⬇️ Short ${short(b)} ${bandPct(band.bps)}`, `k:${pair}:${b}:short`).row();
    }
    kb.text('← Stocks', 'm:call').text('Cancel', 'cancel');
    const text = `<b>${label(pair)}</b> · ${esc(pairBySymbol(pair)!.name)}${q ? ` · ${fmt(q.price, q.price)}` : ''}\n\n`
      + 'Tap a button to <b>lock at the live price</b>. No take-backs.\n'
      + boardsFor(pair).map((b) => `${BOARDS[b].title} expires in ${BOARDS[b].hours} hours`).join(', ') + '.' + (notes.length ? `\n\n${notes.join('\n')}` : '');
    if (ctx.callbackQuery) await ctx.editMessageText(text, { ...HTML, reply_markup: kb });
    else await ctx.reply(text, { ...HTML, reply_markup: kb });
  }

  async function lock(ctx: Context, t: Trader, pair: string, board: BoardId, direction: Direction) {
    try {
      const c = await lockCall(db, { traderId: t.id, pair, board, direction });
      const first = (db.prepare('SELECT COUNT(*) AS n FROM calls WHERE trader_id = ?').get(t.id) as { n: number }).n === 1;
      const text = `✅ <b>ACCEPTED</b> — ${label(pair)} ${direction.toUpperCase()} ${BOARDS[board].title} (${BOARDS[board].hours}h)\n`
        + `Entry ${fmt(c.entry, c.entry)} · TP ${fmt(c.target, c.entry)} · SL ${fmt(c.stop, c.entry)} (${bandPct(c.band_bps)})\n`
        + `Result at ${etTime(c.expires_at)} or sooner: I'll message you <b>PASS</b> or <b>FAILED</b>.\n`
        + `<i>Sealed ${c.commit_hash.slice(0, 12)}: others can't see it until it resolves.</i>`
        + (first ? '\n\n🎉 Your first call!' : '');
      if (ctx.callbackQuery) await ctx.editMessageText(text, HTML); else await ctx.reply(text, HTML);
    } catch (e) {
      if (!(e instanceof CallRejected)) throw e;
      const msg = `🚫 <b>NOT ACCEPTED</b> — ${esc(e.message)}`;
      if (ctx.callbackQuery) await ctx.editMessageText(msg, HTML); else await ctx.reply(msg, HTML);
    }
  }

  async function showMyCalls(ctx: Context, t: Trader) {
    const rows = db.prepare('SELECT * FROM calls WHERE trader_id = ? ORDER BY locked_at DESC LIMIT 15').all(t.id) as unknown as CallRow[];
    await ctx.reply(rows.length ? rows.map(describeCall).join('\n') : 'No calls yet. Tap below to make one.',
      rows.length ? {} : { reply_markup: new InlineKeyboard().text('📈 Make a call', 'm:call') });
  }

  async function showStats(ctx: Context, t: Trader) {
    const now = Date.now();
    const used = (db.prepare('SELECT DISTINCT board FROM calls WHERE trader_id = ?').all(t.id) as { board: BoardId }[]).map((r) => r.board);
    const blocks = BOARD_IDS.filter((b) => used.length ? used.includes(b) : BOARDS[b].group === 'liquid').map((b) => {
      const s = boardStats(db, b, now).get(t.id)!;
      const need = s.qualified ? '' : `\n   ${Math.max(0, SCORING.qualifyMinDecisive - s.decisive)} more wins+losses needed, then confidence above 50% (now ${pct(s.lb)})`;
      return `<b>${BOARDS[b].title}</b>: ${statusLine(s)}\n   ${s.wins}W ${s.losses}L ${s.washes} wash · hit ${pct(s.hitRate)}`
        + (s.copier ? '\n   ⚠️ flagged as copier: copied wins count as losses' : '') + need;
    });
    const p = todayProgress(db, t.id, now);
    const me = rewardBoard(db, now).find((r) => r.trader_id === t.id);
    const w = p.warmup;
    const warm = !w.started ? `🌱 Warmup: starts with your first call (${REWARDS.warmupDays} days, ${REWARDS.warmupActiveDays}+ active trading days)\n`
      : !w.done ? `🌱 Warmup: day ${Math.min(w.days, REWARDS.warmupDays)} of ${REWARDS.warmupDays} · active on ${Math.min(w.activeDays, REWARDS.warmupActiveDays)}/${REWARDS.warmupActiveDays} trading days — calls count, rewards start after\n`
      : '✅ Warmup complete — you\'re in the main game\n';
    const club = `🏆 <b>${pctN(REWARDS.minRate)} club</b> ${p.onTrack ? '— on track today ✅' : ''}\n${warm}`
      + `   Last ${REWARDS.rollingDecisive}: ${p.wins}/${p.n} wins${p.n >= REWARDS.rollingDecisive ? ` (${pct(p.wins / p.n)}, need ${p.need})` : ` · ${REWARDS.rollingDecisive - p.n} more wins+losses to be counted`}\n`
      + `   Today: ${p.calls}/${REWARDS.minCallsToday} calls · Points: ${(me?.points7d ?? 0).toFixed(0)} this week, ${(me?.pointsAll ?? 0).toFixed(0)} all-time`
      + (me?.streak ? ` · 🔥${me.streak}` : '');
    await ctx.reply(`<b>${esc(t.name)}</b>\n\n${club}\n\n${blocks.join('\n\n')}`, HTML);
  }

  async function showRewards(ctx: Context) {
    const rows = rewardBoard(db).slice(0, 15);
    if (!rows.length) return ctx.reply('No calls yet. Be the first!', { reply_markup: new InlineKeyboard().text('📈 Make a call', 'm:call') });
    await ctx.reply(`🏆 <b>${pctN(REWARDS.minRate)} club · points this week</b>\n`
      + rows.map((r, i) => `${i + 1}. ${esc(r.name)} — <b>${r.points7d.toFixed(0)}</b> pts${r.streak ? ` 🔥${r.streak}` : ''} · last 20: ${r.rolling}`).join('\n')
      + `\n\nDaily pool ${REWARDS.dailyPool.toLocaleString()} pts, settled at midnight New York.`,
      { ...HTML, reply_markup: new InlineKeyboard().text('Tiers by board', 'm:tiers') });
  }

  async function showLeaderboard(ctx: Context, only?: BoardId) {
    const active = BOARD_IDS.filter((b) => db.prepare('SELECT 1 FROM calls WHERE board = ? LIMIT 1').get(b));
    const parts = (only ? [only] : active.length ? active : (['intraday', 'swing'] as BoardId[])).map((b) => {
      const rows = leaderboard(db, b).slice(0, 10);
      if (!rows.length) return `<b>${BOARDS[b].title}</b>\nNo calls yet.`;
      return `<b>${BOARDS[b].title}</b>\n` + rows.map((s, i) =>
        `${i + 1}. ${s.tier ? TIER_BADGE[s.tier] : s.eliminated ? '⛔' : '·'} ${esc(s.name)} — ${s.wins}W ${s.losses}L · ${pct(s.hitRate)}`).join('\n');
    });
    await ctx.reply(parts.join('\n\n') + '\n\n🐺 WOLF · 🎯 SHARP · ✅ BASE · · not qualified', HTML);
  }

  // ---------- call flow ----------
  // /call             -> stock picker, then Long/Short per board (the tap locks)
  // /call NVDA         -> straight to the Long/Short buttons
  // /call NVDA long LT -> locks immediately (HT = 2h, LT = 8h)
  bot.command('call', async (ctx) => {
    const t = await requireOnboarded(ctx);
    if (!t) return;
    const [p, d, h] = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (!p) return showPairPicker(ctx);
    const pair = pairByLabel(p);
    if (!pair) return ctx.reply(`Unknown stock "${esc(p)}". Try one of: ${PAIRS.map((x) => x.label).join(', ')}`);
    if (!d) return sessionOpen(Date.now()) ? showDirection(ctx, pair.symbol) : ctx.reply(sessionLine(Date.now()));
    const dir = d.toLowerCase().startsWith('l') ? 'long' : d.toLowerCase().startsWith('s') ? 'short' : null;
    const offered = boardsFor(pair.symbol);
    const board = !h ? (offered.includes('swing') ? 'swing' : 'd1') : boardByTitle(h) ?? null;
    if (!dir || !board) return ctx.reply(`Usage: /call ${pair.label} long ${offered.map((b) => BOARDS[b].title).join(' (or ')}${offered.length > 1 ? ')' : ''}`);
    await lock(ctx, t, pair.symbol, board, dir);
  });

  bot.callbackQuery(/^p:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!sessionOpen(Date.now())) return ctx.editMessageText(sessionLine(Date.now()));
    await showDirection(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^k:(\w+):(intraday|swing):(long|short)$/, async (ctx) => {
    const t = getTrader(ctx);
    if (!t.onboarded_at) { await ctx.answerCallbackQuery(); return startOnboarding(ctx, t); }
    await ctx.answerCallbackQuery({ text: 'Locking…' });
    await lock(ctx, t, ctx.match[1], ctx.match[2] as BoardId, ctx.match[3] as Direction);
  });

  bot.callbackQuery('cancel', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText('Cancelled.'); });

  bot.command('mycalls', async (ctx) => { const t = await requireOnboarded(ctx); if (t) await showMyCalls(ctx, t); });
  bot.command('stats', async (ctx) => { const t = await requireOnboarded(ctx); if (t) await showStats(ctx, t); });
  bot.command('leaderboard', (ctx) => {
    const a = ctx.match.trim().toLowerCase();
    if (!a) return showRewards(ctx);
    return showLeaderboard(ctx, boardByTitle(a));
  });
  bot.command('tiers', (ctx) => showLeaderboard(ctx));
  bot.command(['pairs', 'board'], showPairs);

  bot.callbackQuery(/^m:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const v = ctx.match[1];
    if (v === 'pairs' || v === 'board') return showPairs(ctx);
    if (v === 'leaderboard') return showRewards(ctx);
    if (v === 'tiers') return showLeaderboard(ctx);
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
    if (awaitingName.has(String(ctx.from.id))) return setName(ctx, ctx.message.text);
    if (ctx.message.text.startsWith('/')) return ctx.reply('Unknown command.\n\n' + helpText, HTML);
    const t = getTrader(ctx);
    if (!t.onboarded_at) return startOnboarding(ctx, t);
    // Plain-text calls: "META long LT", "orcl short d2", "$NVDA buy ht". Board optional (LT / D1 by default).
    const m = ctx.message.text.trim().match(/^\$?([a-z]{1,6})(?:\s+(long|short|buy|sell|up|down)(?:\s+(ht|lt|d1|d2|2h|8h|24h|48h))?)?\s*$/i);
    const pair = m && pairByLabel(m[1]);
    if (m && !pair) return ctx.reply(`🚫 <b>NOT ACCEPTED</b> — "${esc(m[1].toUpperCase())}" isn't on the list. Send /pairs to see what you can trade.`, HTML);
    if (pair && !m![2]) return sessionOpen(Date.now()) ? showDirection(ctx, pair.symbol) : ctx.reply(sessionLine(Date.now()));
    if (pair) {
      const dir: Direction = /^(long|buy|up)$/i.test(m![2]) ? 'long' : 'short';
      const hours: Record<string, string> = { '2h': 'ht', '8h': 'lt', '24h': 'd1', '48h': 'd2' };
      const offered = boardsFor(pair.symbol);
      const board = m![3] ? boardByTitle(hours[m![3].toLowerCase()] ?? m![3]) : (offered.includes('swing') ? 'swing' : 'd1');
      if (!board) return ctx.reply('Board must be HT, LT, D1 or D2.');
      return lock(ctx, t, pair.symbol, board, dir);
    }
    await ctx.reply('Type a call like <code>META long LT</code>, or tap a button. /help for more.', { ...HTML, reply_markup: menu() });
  });

  bot.catch((e) => console.error('[bot]', e.error));

  return {
    bot,
    commands: [
      { command: 'pairs', description: 'All stocks you can trade' },
      { command: 'call', description: 'Call a stock: long or short, HT/LT/D1/D2' },
      { command: 'mycalls', description: 'Your recent calls' },
      { command: 'stats', description: 'Your tier, points and progress' },
      { command: 'leaderboard', description: 'Daily rewards leaderboard (65% club)' },
      { command: 'tiers', description: 'Tiers on each board' },
      { command: 'rules', description: 'How scoring works' },
      { command: 'name', description: 'Change your leaderboard name' },
      { command: 'apikey', description: 'API keys for your AI agents' },
      { command: 'help', description: 'All commands' },
    ],
    async notifyResolved(c: CallRow) {
      const tg = (db.prepare('SELECT tg_id FROM traders WHERE id = ?').get(c.trader_id) as { tg_id: string | null })?.tg_id;
      if (!tg) return;
      const s = boardStats(db, c.board, Date.now()).get(c.trader_id)!;
      const p = todayProgress(db, c.trader_id);
      const head = c.status === 'win' ? '✅ <b>PASS</b>' : c.status === 'loss' ? '❌ <b>FAILED</b>'
        : `➖ <b>NO RESULT</b> — ${c.wash_reason === 'ambiguous' ? 'price hit both levels in the same minute' : 'neither level was hit in time'}, so it doesn't count`;
      const how = c.status === 'win' ? `take-profit ${fmt(c.target, c.entry)} hit` : c.status === 'loss' ? `stop ${fmt(c.stop, c.entry)} hit` : `closed at ${fmt(c.exit_price ?? c.entry, c.entry)}`;
      const text = `${head}\n${label(c.pair)} ${c.direction.toUpperCase()} ${BOARDS[c.board].title} from ${fmt(c.entry, c.entry)} — ${how}\n\n`
        + `65% club: last ${p.n} → ${p.wins} pass${p.n >= REWARDS.rollingDecisive ? ` (${pct(p.wins / p.n)}, need ${p.need})` : ` · ${REWARDS.rollingDecisive - p.n} more to count`}\n`
        + `${BOARDS[c.board].title}: ${statusLine(s)} · ${s.wins} pass / ${s.losses} failed\n`
        + `<i>Revealed salt ${c.salt.slice(0, 12)}… (hash ${c.commit_hash.slice(0, 12)})</i>`;
      await bot.api.sendMessage(tg, text, { ...HTML, reply_markup: new InlineKeyboard().text('📈 Call again', 'm:call') }).catch(() => {});
    },
    async notifyReward(r: DailyReward) {
      const tg = (db.prepare('SELECT tg_id FROM traders WHERE id = ?').get(r.trader_id) as { tg_id: string | null })?.tg_id;
      if (!tg) return;
      const text = r.eligible
        ? `🏆 <b>${r.day}: you made the ${pctN(REWARDS.minRate)} club!</b>\n+${r.points.toFixed(0)} points · last ${r.rolling_n}: ${r.rolling_wins} wins · 🔥 streak ${r.streak}`
        : `📅 ${r.day}: no reward today — ${esc(r.reason ?? '')}.\nKeep your last ${REWARDS.rollingDecisive} at ${pctN(REWARDS.minRate)}+ with ${REWARDS.minCallsToday}+ calls a day.`;
      await bot.api.sendMessage(tg, text, { ...HTML, reply_markup: new InlineKeyboard().text('📈 Make a call', 'm:call').text('🏆 Leaderboard', 'm:leaderboard') }).catch(() => {});
    },
    async notifySignal(s: Signal, t: AgentTrade) {
      if (!adminId) return;
      const head = `📡 Consensus: ${label(s.pair)} ${s.direction.toUpperCase()} · ${BOARDS[s.board].title} · ${s.n_traders} traders · ${pct(s.agreement)} of weight`;
      const kb = t.status === 'proposed' && t.mode === 'confirm'
        ? new InlineKeyboard().text('✅ Confirm (paper)', `ok:${t.id}`).text('✖️ Reject', `no:${t.id}`) : undefined;
      await bot.api.sendMessage(adminId, `${head}\n${describeTrade(t)}\n\n${t.reason ?? ''}`, { reply_markup: kb }).catch((e) => console.error(e));
    },
    async notifyTrade(t: AgentTrade) {
      if (adminId) await bot.api.sendMessage(adminId, describeTrade(t)).catch(() => {});
    },
  };
}
