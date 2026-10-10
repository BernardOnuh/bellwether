import { Bot, InlineKeyboard, type Context } from 'grammy';
import { AGENT, BOARDS, BOARD_IDS, PAIRS, SCORING, label, pairBySymbol, pairByLabel, type BoardId, type Direction } from './config.js';
import { execute, getTrade, reject, type AgentTrade } from './agent.js';
import { CallRejected, fmt, lockCall, type CallRow } from './calls.js';
import { setSetting, getSetting, type DB } from './db.js';
import { loadBand, loadQuote } from './bands.js';
import { boardStats, leaderboard, TIER_BADGE, type TraderStats } from './scoring.js';
import { crossesWeekend, sessionLine, sessionOpen } from './sessions.js';
import type { Signal } from './consensus.js';

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '–');
const bandPct = (bps: number) => `±${(bps / 100).toFixed(2)}%`;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const etTime = (t: number) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit' }) + ' ET';
const short = (b: BoardId) => (BOARDS[b].horizonMin >= 60 ? `${BOARDS[b].horizonMin / 60}h` : `${BOARDS[b].horizonMin}m`);
const HTML = { parse_mode: 'HTML' as const };

interface Trader { id: number; name: string; onboarded_at: number | null }

export function describeCall(c: CallRow) {
  const icon = { open: '⏳', win: '✅', loss: '❌', wash: '➖' }[c.status];
  const tail = c.status === 'open' ? `until ${etTime(c.expires_at)}` : c.status === 'wash' ? `wash (${c.wash_reason})` : c.status === 'win' ? 'won' : 'lost';
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

const menu = () => new InlineKeyboard()
  .text('📈 Make a call', 'm:call').text('📋 My calls', 'm:mycalls').row()
  .text('🏆 Leaderboard', 'm:leaderboard').text('📊 My stats', 'm:stats').row()
  .text('💹 Stocks & bands', 'm:board').text('📖 Rules', 'm:rules');

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
      + `<b>Intraday</b> calls last ${short('intraday')}, <b>Swing</b> calls ${short('swing')}.`,
    '• ✅ take-profit first = win · ❌ stop first = loss · ➖ neither by expiry = wash (doesn\'t count).',
    `• Calls open Mon–Fri 04:00–16:00 New York time. Limits: Intraday ${BOARDS.intraday.dailyCap}/day (${BOARDS.intraday.minGapMin} min apart), `
      + `Swing ${BOARDS.swing.dailyCap}/day (${BOARDS.swing.minGapMin} min apart), one open call per stock per board.`,
    '',
    '<b>Scoring</b> (each board separately)',
    `• <b>Qualify</b>: ${SCORING.qualifyMinDecisive}+ wins+losses and 90% statistical confidence you beat a coin flip. Luck doesn't qualify.`,
    '• <b>Tiers</b> on your hit rate (pulled toward 50% for small samples): ✅ BASE 55% 1× · 🎯 SHARP 60% 1.2× · 🐺 WOLF 70% 2×.',
    `• <b>Points</b>: each win from the last ${SCORING.pointsDecayDays} days × your tier, fading to zero over ${SCORING.pointsDecayDays} days, best ${SCORING.winCap} count.`,
    `• <b>Warmup</b>: your first ${SCORING.warmupDays} days build your record but earn no points.`,
    '• <b>Copying</b>: habitually opening the same trade minutes after someone else turns your copied wins into losses.',
    `• <b>Elimination</b>: after ${SCORING.elimMinDecisive}+ calls, a hit rate confidently below 45% removes you from the board.`,
    '',
    '🔒 Open calls are sealed: others see only a fingerprint until they resolve.',
  ].join('\n');

  const helpText = [
    '<b>Commands</b>',
    '/call — make a call (or <code>/call NVDA long 8h</code>)',
    '/mycalls — your recent calls',
    '/stats — your tier, points and progress',
    '/leaderboard — top traders on each board',
    '/board — stocks, bands and market hours',
    '/rules — how scoring works',
    '/name — change your leaderboard name',
  ].join('\n');

  function exampleLine() {
    const q = loadQuote(db, 'NVDAUSDT'), b = loadBand(db, 'NVDAUSDT', 'swing');
    if (!q || !b) return 'Example: NVDA long on Swing → take-profit about 1% above entry, stop 1% below, 8 hours to get there.';
    const d = (q.price * b.bps) / 1e4;
    return `Example right now: NVDA is ${fmt(q.price, q.price)}. A <b>Swing long</b> takes profit at ${fmt(q.price + d, q.price)} `
      + `and stops at ${fmt(q.price - d, q.price)} (${bandPct(b.bps)}), with ${short('swing')} to get there.`;
  }

  const TUTORIAL = [
    () => '<b>1/3 · Making a call</b>\n\nPick a stock, then tap <b>Long</b> (up) or <b>Short</b> (down) on the '
      + `<b>Intraday</b> (${short('intraday')}) or <b>Swing</b> (${short('swing')}) board. That's it: two taps.\n\n`
      + 'Your tap locks the live price. The house sets take-profit and stop at the same distance, so every call is an equal test of skill.\n\n'
      + exampleLine(),
    () => '<b>2/3 · How you\'re ranked</b>\n\n✅ take-profit first = win · ❌ stop first = loss · ➖ neither = wash\n\n'
      + `After ${SCORING.qualifyMinDecisive}+ wins+losses, you qualify once we're 90% sure you beat a coin flip. `
      + 'Then your hit rate sets a tier: ✅ BASE 55% · 🎯 SHARP 60% · 🐺 WOLF 70% (2× points).\n\n'
      + `Points come from your last ${SCORING.pointsDecayDays} days of wins, so the board rewards current form. `
      + `Your first ${SCORING.warmupDays} days are warmup: they build your record but don't earn points.`,
    () => '<b>3/3 · What your calls power</b>\n\nWhen several top-tier traders call the same stock the same way, an AI agent '
      + 'proposes that trade. A human confirms it, and it runs on a <b>Bitget demo account</b> (paper money).\n\n'
      + '• 🔒 Your open calls are sealed. Nobody can copy them live, and copying others doesn\'t pay.\n'
      + '• 🕓 Calls open Mon–Fri 04:00–16:00 New York time.\n'
      + '• No deposits. We will never ask for money, keys or passwords. Not financial advice.',
  ];

  // ---------- onboarding ----------
  async function startOnboarding(ctx: Context, t: Trader) {
    await ctx.reply(
      '👋 <b>Welcome to Bellwether!</b>\n\nCall where US stocks go next, get graded against live Bitget prices, '
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
      ...HTML, reply_markup: new InlineKeyboard().text('📈 Make my first call', 'm:call').row().text('💹 See stocks & bands', 'm:board'),
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
  bot.command('help', (ctx) => ctx.reply(helpText, { ...HTML, reply_markup: menu() }));
  bot.command('rules', (ctx) => ctx.reply(rulesText(), HTML));

  // ---------- views ----------
  async function showBoard(ctx: Context) {
    const lines = PAIRS.map((p) => {
      const q = loadQuote(db, p.symbol);
      const bands = BOARD_IDS.map((b) => { const x = loadBand(db, p.symbol, b); return x?.listed ? `${short(b)} ${bandPct(x.bps)}` : `${short(b)} –`; });
      return `<b>${p.label}</b> ${q ? fmt(q.price, q.price) : '…'} · ${bands.join(' · ')}`;
    });
    await ctx.reply(`${sessionLine(Date.now())}\n\n${lines.join('\n')}\n\nBands are the take-profit/stop distance. They're recalibrated daily from the last 30 days.`, HTML);
  }

  async function showPairPicker(ctx: Context) {
    const now = Date.now();
    if (!sessionOpen(now)) return ctx.reply(`${sessionLine(now)}\n\nMeanwhile: /leaderboard · /stats · /board`);
    const kb = new InlineKeyboard();
    PAIRS.forEach((pp, i) => { kb.text(pp.label, `p:${pp.symbol}`); if (i % 5 === 4) kb.row(); });
    kb.row().text('Cancel', 'cancel');
    await ctx.reply(`${sessionLine(now)}\nPick a stock:`, { reply_markup: kb });
  }

  async function showDirection(ctx: Context, pair: string) {
    const now = Date.now();
    const q = loadQuote(db, pair);
    const kb = new InlineKeyboard();
    const notes: string[] = [];
    for (const b of BOARD_IDS) {
      const band = loadBand(db, pair, b);
      if (!band?.listed) { notes.push(`${BOARDS[b].title}: not listed for ${label(pair)}.`); continue; }
      if (crossesWeekend(now + BOARDS[b].horizonMin * 60_000)) { notes.push(`${BOARDS[b].title}: would run into the weekend.`); continue; }
      kb.text(`⬆️ Long ${short(b)} ${bandPct(band.bps)}`, `k:${pair}:${b}:long`).text(`⬇️ Short ${short(b)} ${bandPct(band.bps)}`, `k:${pair}:${b}:short`).row();
    }
    kb.text('← Stocks', 'm:call').text('Cancel', 'cancel');
    const text = `<b>${label(pair)}</b> · ${esc(pairBySymbol(pair)!.name)}${q ? ` · ${fmt(q.price, q.price)}` : ''}\n\n`
      + 'Tap a button to <b>lock at the live price</b>. No take-backs.\n'
      + `Intraday expires in ${short('intraday')}, Swing in ${short('swing')}.` + (notes.length ? `\n\n${notes.join('\n')}` : '');
    if (ctx.callbackQuery) await ctx.editMessageText(text, { ...HTML, reply_markup: kb });
    else await ctx.reply(text, { ...HTML, reply_markup: kb });
  }

  async function lock(ctx: Context, t: Trader, pair: string, board: BoardId, direction: Direction) {
    try {
      const c = await lockCall(db, { traderId: t.id, pair, board, direction });
      const first = (db.prepare('SELECT COUNT(*) AS n FROM calls WHERE trader_id = ?').get(t.id) as { n: number }).n === 1;
      const text = `🔒 <b>Locked</b> ${label(pair)} ${direction.toUpperCase()} · ${BOARDS[board].title}\n`
        + `Entry ${fmt(c.entry, c.entry)} · TP ${fmt(c.target, c.entry)} · SL ${fmt(c.stop, c.entry)} (${bandPct(c.band_bps)})\n`
        + `Expires ${etTime(c.expires_at)}\n\nSealed as <code>${c.commit_hash.slice(0, 12)}</code>. Others see only this until it resolves.`
        + (first ? '\n\n🎉 Your first call! I\'ll message you when it resolves.' : '');
      if (ctx.callbackQuery) await ctx.editMessageText(text, HTML); else await ctx.reply(text, HTML);
    } catch (e) {
      if (!(e instanceof CallRejected)) throw e;
      if (ctx.callbackQuery) await ctx.editMessageText(`🚫 ${e.message}`); else await ctx.reply(`🚫 ${e.message}`);
    }
  }

  async function showMyCalls(ctx: Context, t: Trader) {
    const rows = db.prepare('SELECT * FROM calls WHERE trader_id = ? ORDER BY locked_at DESC LIMIT 15').all(t.id) as unknown as CallRow[];
    await ctx.reply(rows.length ? rows.map(describeCall).join('\n') : 'No calls yet. Tap below to make one.',
      rows.length ? {} : { reply_markup: new InlineKeyboard().text('📈 Make a call', 'm:call') });
  }

  async function showStats(ctx: Context, t: Trader) {
    const now = Date.now();
    const blocks = BOARD_IDS.map((b) => {
      const s = boardStats(db, b, now).get(t.id)!;
      const need = s.qualified ? '' : `\n   ${Math.max(0, SCORING.qualifyMinDecisive - s.decisive)} more wins+losses needed, then confidence above 50% (now ${pct(s.lb)})`;
      return `<b>${BOARDS[b].title}</b>: ${statusLine(s)}\n   ${s.wins}W ${s.losses}L ${s.washes} wash · hit ${pct(s.hitRate)} · points ${s.points.toFixed(2)}`
        + (s.copier ? '\n   ⚠️ flagged as copier: copied wins count as losses' : '') + need;
    });
    await ctx.reply(`<b>${esc(t.name)}</b>\n\n${blocks.join('\n\n')}`, HTML);
  }

  async function showLeaderboard(ctx: Context, only?: BoardId) {
    const parts = (only ? [only] : BOARD_IDS).map((b) => {
      const rows = leaderboard(db, b).slice(0, 10);
      if (!rows.length) return `<b>${BOARDS[b].title}</b>\nNo calls yet.`;
      return `<b>${BOARDS[b].title}</b>\n` + rows.map((s, i) =>
        `${i + 1}. ${s.tier ? TIER_BADGE[s.tier] : s.eliminated ? '⛔' : '·'} ${esc(s.name)} — ${s.points.toFixed(1)} pts · ${s.wins}W ${s.losses}L · ${pct(s.hitRate)}`).join('\n');
    });
    await ctx.reply(parts.join('\n\n') + '\n\n🐺 WOLF · 🎯 SHARP · ✅ BASE · · not qualified', HTML);
  }

  // ---------- call flow ----------
  // /call             -> stock picker, then Long/Short per board (the tap locks)
  // /call NVDA         -> straight to the Long/Short buttons
  // /call NVDA long 8h -> locks immediately
  bot.command('call', async (ctx) => {
    const t = await requireOnboarded(ctx);
    if (!t) return;
    const [p, d, h] = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (!p) return showPairPicker(ctx);
    const pair = pairByLabel(p);
    if (!pair) return ctx.reply(`Unknown stock "${esc(p)}". Try one of: ${PAIRS.map((x) => x.label).join(', ')}`);
    if (!d) return sessionOpen(Date.now()) ? showDirection(ctx, pair.symbol) : ctx.reply(sessionLine(Date.now()));
    const dir = d.toLowerCase().startsWith('l') ? 'long' : d.toLowerCase().startsWith('s') ? 'short' : null;
    const board = !h || /^(8h|swing|s)$/i.test(h) ? 'swing' : /^(2h|intraday|i)$/i.test(h) ? 'intraday' : null;
    if (!dir || !board) return ctx.reply('Usage: /call NVDA long 8h   (or 2h)');
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
    return showLeaderboard(ctx, a.startsWith('i') || a === '2h' ? 'intraday' : a.startsWith('s') || a === '8h' ? 'swing' : undefined);
  });
  bot.command(['board', 'pairs'], showBoard);

  bot.callbackQuery(/^m:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const v = ctx.match[1];
    if (v === 'board') return showBoard(ctx);
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
    if (awaitingName.has(String(ctx.from.id))) return setName(ctx, ctx.message.text);
    if (ctx.message.text.startsWith('/')) return ctx.reply('Unknown command.\n\n' + helpText, HTML);
    const t = getTrader(ctx);
    if (!t.onboarded_at) return startOnboarding(ctx, t);
    const pair = pairByLabel(ctx.message.text.trim().replace(/^\$/, ''));
    if (pair && sessionOpen(Date.now())) return showDirection(ctx, pair.symbol);   // typing "NVDA" opens its buttons
    await ctx.reply('Tap a button or use /help.', { reply_markup: menu() });
  });

  bot.catch((e) => console.error('[bot]', e.error));

  return {
    bot,
    commands: [
      { command: 'call', description: 'Call a stock: long or short, 2h or 8h' },
      { command: 'mycalls', description: 'Your recent calls' },
      { command: 'stats', description: 'Your tier, points and progress' },
      { command: 'leaderboard', description: 'Top traders on each board' },
      { command: 'board', description: 'Stocks, bands and market hours' },
      { command: 'rules', description: 'How scoring works' },
      { command: 'name', description: 'Change your leaderboard name' },
      { command: 'help', description: 'All commands' },
    ],
    async notifyResolved(c: CallRow) {
      const tg = (db.prepare('SELECT tg_id FROM traders WHERE id = ?').get(c.trader_id) as { tg_id: string | null })?.tg_id;
      if (!tg) return;
      const s = boardStats(db, c.board, Date.now()).get(c.trader_id)!;
      const text = `${describeCall(c)}\n${BOARDS[c.board].title}: ${statusLine(s)} · ${s.wins}W ${s.losses}L · ${s.points.toFixed(2)} pts`
        + `\n🔓 Revealed: salt <code>${c.salt}</code> (hash <code>${c.commit_hash.slice(0, 12)}</code>)`;
      await bot.api.sendMessage(tg, text, { ...HTML, reply_markup: new InlineKeyboard().text('📈 Call again', 'm:call') }).catch(() => {});
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
