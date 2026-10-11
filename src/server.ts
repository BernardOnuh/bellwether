// One-page dashboard: 65% club, tiers per board, sealed call feed, bands, consensus signals, agent trades, backtest headline.
// GET /?db=sim shows the simulated replay; default is the live database.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { openDb, getSetting, type DB } from './db.js';
import { leaderboard } from './scoring.js';
import { BOARDS, BOARD_IDS, PAIRS, REWARDS } from './config.js';
import { rewardBoard, ensureRewardsTable } from './rewards.js';
import { sessionLine } from './sessions.js';

const dbs = new Map<string, DB>();
const dbFor = (name: string) => {
  const file = name === 'sim' ? 'data/sim.db' : process.env.DB_FILE ?? 'data/live.db';
  if (!dbs.has(file)) dbs.set(file, openDb(file));
  return dbs.get(file)!;
};

function state(which: string) {
  const db = dbFor(which);
  // Open calls are sealed: only trader, board, lock time and the commit hash are public until they resolve.
  const calls = (db.prepare(`SELECT c.*, t.name FROM calls c JOIN traders t ON t.id = c.trader_id ORDER BY c.locked_at DESC LIMIT 40`).all() as Record<string, unknown>[])
    .map((c) => c.status === 'open'
      ? { id: c.id, name: c.name, board: c.board, locked_at: c.locked_at, expires_at: c.expires_at, status: 'open', commit_hash: c.commit_hash }
      : c);
  const signals = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 20').all();
  const trades = db.prepare('SELECT * FROM agent_trades ORDER BY created_at DESC LIMIT 20').all();
  const bands = db.prepare('SELECT b.*, q.price FROM bands b LEFT JOIN quotes q ON q.pair = b.pair ORDER BY b.pair, b.board').all();
  const counts = db.prepare(`SELECT COUNT(*) AS calls, SUM(status='win') AS wins, SUM(status='loss') AS losses, SUM(status='wash') AS washes,
    SUM(status='open') AS open FROM calls`).get();
  const asOf = which === 'sim' ? Number((db.prepare('SELECT MAX(resolved_at) AS t FROM calls').get() as { t: number | null }).t ?? Date.now()) : Date.now();
  ensureRewardsTable(db);
  const lastDay = (db.prepare('SELECT MAX(day) AS d FROM daily_rewards').get() as { d: string | null }).d;
  const lastDayRows = lastDay ? db.prepare('SELECT COUNT(*) AS traders, SUM(eligible) AS qualified FROM daily_rewards WHERE day = ?').get(lastDay) : null;
  return {
    which, simulated: which === 'sim', kill: getSetting(db, 'kill') === '1', counts, session: sessionLine(Date.now()),
    boardMeta: BOARD_IDS.map((b) => ({ id: b, title: BOARDS[b].title, hours: BOARDS[b].hours, group: BOARDS[b].group })),
    pairs: PAIRS,
    boards: Object.fromEntries(BOARD_IDS.map((b) => [b, { title: BOARDS[b].title, leaderboard: leaderboard(db, b, asOf).slice(0, 20) }])),
    rewards: { rule: REWARDS, lastDay, lastDayRows, board: rewardBoard(db, asOf + 86_400_000).slice(0, 25) },
    calls, signals, trades, bands,
    backtest: existsSync('results/backtest.json') ? JSON.parse(readFileSync('results/backtest.json', 'utf8')) : null,
  };
}

export function startDashboard(port: number) {
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(state(url.searchParams.get('db') ?? 'live')));
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(new URL('./dashboard.html', import.meta.url)));
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  }).listen(port, () => console.log(`Dashboard on http://localhost:${port}  (simulated: /?db=sim)`));
}

if (import.meta.url === `file://${process.argv[1]}`) startDashboard(Number(process.env.DASHBOARD_PORT ?? 8787));
