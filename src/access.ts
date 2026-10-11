// Data API access: read-only keys that unlock full trade histories. Requested through the Telegram bot,
// approved by the admin with one tap, delivered to the requester by DM. Keys are stored only as sha256 hashes.
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from './db.js';

const DDL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY, owner_tg TEXT NOT NULL, label TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'data',
  key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY, tg_id TEXT NOT NULL, name TEXT NOT NULL, purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at INTEGER NOT NULL, decided_at INTEGER, key_id INTEGER REFERENCES api_keys(id)
);`;
export const ensureAccessTables = (db: DB) => db.exec(DDL);

const hash = (k: string) => createHash('sha256').update(k).digest('hex');

export interface AccessRequest { id: number; tg_id: string; name: string; purpose: string; status: string; created_at: number; decided_at: number | null; key_id: number | null }

export function activeDataKey(db: DB, tgId: string) {
  ensureAccessTables(db);
  return db.prepare('SELECT id, prefix, created_at FROM api_keys WHERE owner_tg = ? AND revoked_at IS NULL ORDER BY id DESC').get(tgId) as { id: number; prefix: string; created_at: number } | undefined;
}

export function createRequest(db: DB, tgId: string, name: string, purpose: string): AccessRequest | { error: string } {
  ensureAccessTables(db);
  const p = purpose.trim().slice(0, 500);
  if (p.length < 10) return { error: 'Tell us a bit more (at least 10 characters) about what you will use the data for.' };
  if (activeDataKey(db, tgId)) return { error: 'You already have an active data key. Use /requestapi status to see it.' };
  if (db.prepare("SELECT 1 FROM access_requests WHERE tg_id = ? AND status = 'pending'").get(tgId)) return { error: 'Your request is already waiting for review.' };
  const r = db.prepare('INSERT INTO access_requests (tg_id, name, purpose, created_at) VALUES (?, ?, ?, ?)').run(tgId, name, p, Date.now());
  return db.prepare('SELECT * FROM access_requests WHERE id = ?').get(r.lastInsertRowid) as unknown as AccessRequest;
}

/** Approve: mint a data key for the requester. Returns the plaintext key once. */
export function approveRequest(db: DB, id: number): { request: AccessRequest; key: string } | null {
  ensureAccessTables(db);
  const req = db.prepare("SELECT * FROM access_requests WHERE id = ? AND status = 'pending'").get(id) as unknown as AccessRequest | undefined;
  if (!req) return null;
  const key = `bwd_${randomBytes(24).toString('hex')}`;
  const k = db.prepare('INSERT INTO api_keys (owner_tg, label, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.tg_id, req.name, hash(key), key.slice(0, 11), Date.now());
  db.prepare("UPDATE access_requests SET status = 'approved', decided_at = ?, key_id = ? WHERE id = ?").run(Date.now(), k.lastInsertRowid, id);
  return { request: { ...req, status: 'approved' }, key };
}

export function denyRequest(db: DB, id: number): AccessRequest | null {
  ensureAccessTables(db);
  const req = db.prepare("SELECT * FROM access_requests WHERE id = ? AND status = 'pending'").get(id) as unknown as AccessRequest | undefined;
  if (!req) return null;
  db.prepare("UPDATE access_requests SET status = 'denied', decided_at = ? WHERE id = ?").run(Date.now(), id);
  return { ...req, status: 'denied' };
}

export function revokeDataKey(db: DB, tgId: string): boolean {
  ensureAccessTables(db);
  return Number(db.prepare('UPDATE api_keys SET revoked_at = ? WHERE owner_tg = ? AND revoked_at IS NULL').run(Date.now(), tgId).changes) > 0;
}

export function authDataKey(db: DB, bearer: string | undefined): { id: number; owner_tg: string } | null {
  const key = bearer?.replace(/^Bearer\s+/i, '').trim();
  if (!key || !/^bwd_[0-9a-f]{48}$/.test(key)) return null;
  ensureAccessTables(db);
  return (db.prepare('SELECT id, owner_tg FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(hash(key)) as { id: number; owner_tg: string } | undefined) ?? null;
}
