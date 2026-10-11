// AI agents as traders. A Telegram user creates up to 3 agents; each gets an API key (shown once, stored as sha256).
// Agents play under the same rules as humans: sessions, caps, sealing, warmup, copy detection, the 65% club.
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from './db.js';

export const MAX_AGENTS_PER_OWNER = 3;
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export interface AgentRow { id: number; name: string; api_key_prefix: string; created_at: number; revoked_at: number | null; first_call_at: number | null }

export function agentName(raw: string): string | null {
  const n = raw.trim().replace(/^🤖\s*/, '');
  return /^[A-Za-z0-9_.-]{3,20}$/.test(n) ? `🤖 ${n}` : null;
}

export function createAgent(db: DB, ownerTg: string, rawName: string): { key: string; agent: AgentRow } | { error: string } {
  const name = agentName(rawName);
  if (!name) return { error: 'Agent names are 3–20 characters: letters, numbers, _ . -' };
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM traders WHERE kind = 'agent' AND owner_tg = ? AND revoked_at IS NULL").get(ownerTg) as { n: number };
  if (n >= MAX_AGENTS_PER_OWNER) return { error: `You already have ${MAX_AGENTS_PER_OWNER} agents. Revoke one first.` };
  if (db.prepare('SELECT 1 FROM traders WHERE lower(name) = lower(?)').get(name)) return { error: 'That agent name is taken.' };
  const key = `bw_${randomBytes(24).toString('hex')}`;
  const now = Date.now();
  const r = db.prepare(`INSERT INTO traders (name, kind, owner_tg, api_key_hash, api_key_prefix, created_at, onboarded_at)
    VALUES (?, 'agent', ?, ?, ?, ?, ?)`).run(name, ownerTg, hashKey(key), key.slice(0, 10), now, now);
  return { key, agent: db.prepare('SELECT * FROM traders WHERE id = ?').get(r.lastInsertRowid) as unknown as AgentRow };
}

export const listAgents = (db: DB, ownerTg: string) =>
  db.prepare("SELECT id, name, api_key_prefix, created_at, revoked_at, first_call_at FROM traders WHERE kind = 'agent' AND owner_tg = ? ORDER BY id")
    .all(ownerTg) as unknown as AgentRow[];

/** Revoking stops the key; the agent's record and calls stay on the board. */
export function revokeAgent(db: DB, ownerTg: string, rawName: string): boolean {
  const name = agentName(rawName);
  const r = db.prepare("UPDATE traders SET revoked_at = ?, api_key_hash = NULL WHERE kind = 'agent' AND owner_tg = ? AND lower(name) = lower(?) AND revoked_at IS NULL")
    .run(Date.now(), ownerTg, name ?? rawName);
  return Number(r.changes) > 0;
}

export function authAgent(db: DB, bearer: string | undefined): { id: number; name: string } | null {
  const key = bearer?.replace(/^Bearer\s+/i, '').trim();
  if (!key || !/^bw_[0-9a-f]{48}$/.test(key)) return null;
  return (db.prepare("SELECT id, name FROM traders WHERE kind = 'agent' AND api_key_hash = ? AND revoked_at IS NULL").get(hashKey(key)) as { id: number; name: string } | undefined) ?? null;
}
