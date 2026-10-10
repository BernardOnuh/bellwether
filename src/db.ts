import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traders (
  id INTEGER PRIMARY KEY,
  tg_id TEXT UNIQUE,
  name TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0,
  sim_skill TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  trader_id INTEGER NOT NULL REFERENCES traders(id),
  pair TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  distance REAL NOT NULL,
  entry REAL NOT NULL,
  target REAL NOT NULL,
  stop REAL NOT NULL,
  bid REAL, ask REAL,
  window_min INTEGER NOT NULL,
  band_ratio REAL NOT NULL,          -- distance / typical range for the window
  locked_at INTEGER NOT NULL,        -- server timestamp (ms)
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','win','loss','wash')),
  wash_reason TEXT,                  -- expired | ambiguous
  exit_price REAL,
  resolved_at INTEGER,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS calls_open ON calls(status, pair);
CREATE INDEX IF NOT EXISTS calls_trader ON calls(trader_id, locked_at);
CREATE TABLE IF NOT EXISTS pair_profiles (
  pair TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  price REAL NOT NULL,
  spread REAL NOT NULL,
  rv24h REAL NOT NULL,
  volatile INTEGER NOT NULL,
  window_min INTEGER NOT NULL,
  typical_range REAL NOT NULL,
  band_lo REAL NOT NULL,
  band_hi REAL NOT NULL,
  min_distance REAL NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  n_traders INTEGER NOT NULL,
  weight REAL NOT NULL,
  agreement REAL NOT NULL,
  distance REAL NOT NULL,
  window_min INTEGER NOT NULL,
  call_ids TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_trades (
  id INTEGER PRIMARY KEY,
  signal_id INTEGER REFERENCES signals(id),
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry REAL NOT NULL,
  target REAL NOT NULL,
  stop REAL NOT NULL,
  distance REAL NOT NULL,
  qty REAL NOT NULL,
  window_min INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  opened_at INTEGER,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,              -- proposed | rejected | blocked | open | win | loss | wash | error
  mode TEXT NOT NULL,                -- confirm | paper
  risk_note TEXT,
  reason TEXT,
  order_id TEXT,
  exit_price REAL,
  pnl_r REAL,
  resolved_at INTEGER,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS paper_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  args TEXT NOT NULL,
  ok INTEGER NOT NULL,
  response TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export type DB = DatabaseSync;

export function openDb(file = process.env.DB_FILE ?? 'data/live.db'): DB {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function getSetting(db: DB, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value;
}
export function setSetting(db: DB, key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
