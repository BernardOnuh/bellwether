import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traders (
  id INTEGER PRIMARY KEY,
  tg_id TEXT UNIQUE,
  name TEXT NOT NULL,
  username TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  sim_skill TEXT,
  created_at INTEGER NOT NULL,
  onboarded_at INTEGER,
  first_call_at INTEGER                -- starts the warmup clock
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  trader_id INTEGER NOT NULL REFERENCES traders(id),
  board TEXT NOT NULL,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  band_bps REAL NOT NULL,              -- house band in force at lock
  distance REAL NOT NULL,              -- entry x band_bps / 1e4
  entry REAL NOT NULL,
  target REAL NOT NULL,
  stop REAL NOT NULL,
  bid REAL, ask REAL,
  locked_at INTEGER NOT NULL,          -- exchange server time (ms)
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','win','loss','wash')),
  wash_reason TEXT,                    -- expired | ambiguous
  exit_price REAL,
  resolved_at INTEGER,
  copied_from INTEGER,                 -- an earlier open call on the same pair/direction/board within the copy lag
  commit_hash TEXT NOT NULL,           -- sha256 published while the call is sealed
  salt TEXT NOT NULL,                  -- revealed after resolution so anyone can check the hash
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS calls_open ON calls(status, pair);
CREATE INDEX IF NOT EXISTS calls_trader ON calls(trader_id, board, locked_at);
CREATE INDEX IF NOT EXISTS calls_pair ON calls(pair, direction, board, locked_at);
CREATE TABLE IF NOT EXISTS bands (
  pair TEXT NOT NULL,
  board TEXT NOT NULL,
  bps REAL NOT NULL,
  spread_bps REAL NOT NULL,
  windows INTEGER NOT NULL,
  listed INTEGER NOT NULL,             -- passes the band >= 8x spread gate
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (pair, board)
);
CREATE TABLE IF NOT EXISTS band_history (
  pair TEXT NOT NULL, board TEXT NOT NULL, bps REAL NOT NULL, spread_bps REAL NOT NULL,
  listed INTEGER NOT NULL, computed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  pair TEXT PRIMARY KEY,
  price REAL NOT NULL,
  bid REAL NOT NULL,
  ask REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  board TEXT NOT NULL,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  n_traders INTEGER NOT NULL,
  weight REAL NOT NULL,
  agreement REAL NOT NULL,
  band_bps REAL NOT NULL,
  call_ids TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_trades (
  id INTEGER PRIMARY KEY,
  signal_id INTEGER REFERENCES signals(id),
  board TEXT NOT NULL,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry REAL NOT NULL,
  target REAL NOT NULL,
  stop REAL NOT NULL,
  distance REAL NOT NULL,
  qty REAL NOT NULL,
  horizon_min INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  opened_at INTEGER,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,                -- proposed | rejected | blocked | open | win | loss | wash | error
  mode TEXT NOT NULL,                  -- confirm | paper | sim
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
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrateFromV1(db);
  db.exec(SCHEMA);
  // Agents (API traders): owned by a Telegram user, authenticated by an API key stored only as a sha256 hash.
  const tcols = (db.prepare('PRAGMA table_info(traders)').all() as { name: string }[]).map((c) => c.name);
  for (const [c, t] of [['kind', "TEXT NOT NULL DEFAULT 'human'"], ['owner_tg', 'TEXT'], ['api_key_hash', 'TEXT'], ['api_key_prefix', 'TEXT'], ['revoked_at', 'INTEGER']])
    if (!tcols.includes(c)) db.exec(`ALTER TABLE traders ADD COLUMN ${c} ${t}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS traders_api_key ON traders(api_key_hash) WHERE api_key_hash IS NOT NULL');
  db.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
  return db;
}

/** v1 had trader-chosen distances and no boards. Its tables are only replaced when they hold no calls. */
function migrateFromV1(db: DB) {
  const hasCalls = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'calls'").get();
  if (!hasCalls) return;
  const cols = (db.prepare('PRAGMA table_info(calls)').all() as { name: string }[]).map((c) => c.name);
  if (cols.includes('board')) return;
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM calls').get() as { n: number };
  if (n > 0) throw new Error('Database has v1 calls (trader-chosen distances). Move it aside (e.g. data/live.v1.db) before starting v2.');
  db.exec('DROP TABLE IF EXISTS agent_trades; DROP TABLE IF EXISTS signals; DROP TABLE calls; DROP TABLE IF EXISTS pair_profiles;');
  const tcols = (db.prepare('PRAGMA table_info(traders)').all() as { name: string }[]).map((c) => c.name);
  for (const [c, t] of [['onboarded_at', 'INTEGER'], ['username', 'TEXT'], ['first_call_at', 'INTEGER']])
    if (!tcols.includes(c)) db.exec(`ALTER TABLE traders ADD COLUMN ${c} ${t}`);
}

export function getSetting(db: DB, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value;
}
export function setSetting(db: DB, key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
