// One-page dashboard: leaderboard, call feed, consensus signals, agent trades, and the backtest headline chart.
// GET /?db=sim shows the simulated replay; default is the live database.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { openDb, getSetting, type DB } from './db.js';
import { leaderboard } from './scoring.js';

const dbs = new Map<string, DB>();
const dbFor = (name: string) => {
  const file = name === 'sim' ? 'data/sim.db' : process.env.DB_FILE ?? 'data/live.db';
  if (!dbs.has(file)) dbs.set(file, openDb(file));
  return dbs.get(file)!;
};

function state(which: string) {
  const db = dbFor(which);
  const calls = db.prepare(`SELECT c.*, t.name FROM calls c JOIN traders t ON t.id = c.trader_id ORDER BY c.locked_at DESC LIMIT 40`).all();
  const signals = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 20').all();
  const trades = db.prepare('SELECT * FROM agent_trades ORDER BY created_at DESC LIMIT 20').all();
  const profiles = db.prepare('SELECT * FROM pair_profiles ORDER BY pair').all();
  const paper = db.prepare('SELECT ts, kind, ok FROM paper_log ORDER BY ts DESC LIMIT 20').all();
  const counts = db.prepare(`SELECT COUNT(*) AS calls, SUM(status='win') AS wins, SUM(status='loss') AS losses, SUM(status='wash') AS washes,
    SUM(status='open') AS open FROM calls`).get();
  return {
    which, simulated: which === 'sim', kill: getSetting(db, 'kill') === '1', counts,
    leaderboard: leaderboard(db).slice(0, 25), calls, signals, trades, profiles, paper,
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
