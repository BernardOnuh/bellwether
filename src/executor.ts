// Thin wrapper around Bitget's `bgc` CLI. Every write is forced onto the demo environment with --paper-trading,
// and every invocation (including dry runs and failures) is appended to paper_log.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { CATEGORY } from './config.js';
import type { DB } from './db.js';

const require = createRequire(import.meta.url);
const BGC = path.join(path.dirname(require.resolve('@bitget-ai/bitget-agent-cli/package.json')), 'lib/index.js');

export interface BgcResult { ok: boolean; data: unknown; raw: string }

function bgc(args: string[]): Promise<BgcResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BGC, ...args, '--paper-trading'], { timeout: 30_000, env: process.env }, (err, stdout, stderr) => {
      const raw = (stdout || stderr || String(err ?? '')).trim();
      let data: unknown = raw;
      try { data = JSON.parse(stdout); } catch { /* keep raw text */ }
      const apiError = typeof data === 'object' && data !== null && 'error' in data;
      resolve({ ok: !err && !apiError, data, raw });
    });
  });
}

async function logged(db: DB, kind: string, args: string[]) {
  const r = await bgc(args);
  db.prepare('INSERT INTO paper_log (ts, kind, args, ok, response) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), kind, JSON.stringify(args), r.ok ? 1 : 0, r.raw.slice(0, 4000));
  return r;
}

export const hasDemoKeys = () => !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET_KEY && process.env.BITGET_PASSPHRASE);

export function placeBracket(db: DB, o: {
  symbol: string; side: 'buy' | 'sell'; qty: string; takeProfit: string; stopLoss: string; clientOid?: string; dryRun?: boolean;
}) {
  const args = ['order', '--action', 'place', '--category', CATEGORY, '--symbol', o.symbol, '--side', o.side,
    '--orderType', 'market', '--qty', o.qty, '--takeProfit', o.takeProfit, '--stopLoss', o.stopLoss,
    '--tpTriggerBy', 'market', '--slTriggerBy', 'market'];
  if (o.clientOid) args.push('--clientOid', o.clientOid);
  if (o.dryRun) args.push('--dry-run');
  return logged(db, o.dryRun ? 'place.dryrun' : 'place', args);
}

export function closePosition(db: DB, symbol: string) {
  return logged(db, 'close', ['position', '--action', 'close', '--category', CATEGORY, '--symbol', symbol]);
}

export function positions(db: DB) {
  return logged(db, 'positions', ['position', '--action', 'info', '--category', CATEGORY]);
}

export function accountOverview(db: DB) {
  return logged(db, 'account', ['account_overview', '--coin', 'USDT']);
}
