// Phase 1 "start the clock": one tiny bracket order on Bitget's demo environment, dry-run first.
import { openDb } from '../src/db.js';
import { accountOverview, closePosition, hasDemoKeys, placeBracket } from '../src/executor.js';
import { instrument, roundTo, ticker } from '../src/market.js';

const db = openDb();
const symbol = process.argv[2] ?? 'BTCUSDT';
const live = process.argv.includes('--send');

const [t, inst] = await Promise.all([ticker(symbol), instrument(symbol)]);
const qty = Math.max(inst.minQty, Math.ceil(inst.minNotional / t.mid / inst.qtyStep) * inst.qtyStep);
const d = t.mid * 0.01;
const order = {
  symbol, side: 'buy' as const, qty: roundTo(qty, inst.qtyPrecision).toString(),
  takeProfit: roundTo(t.mid + d, inst.pricePrecision).toString(), stopLoss: roundTo(t.mid - d, inst.pricePrecision).toString(),
};

console.log('dry run:', JSON.stringify((await placeBracket(db, { ...order, dryRun: true })).data, null, 2));
if (!live) {
  console.log('\nRe-run with --send to place it on the demo account.');
  process.exit(0);
}
if (!hasDemoKeys()) throw new Error('Set BITGET_API_KEY / BITGET_SECRET_KEY / BITGET_PASSPHRASE (demo key) in .env');
const acct = await accountOverview(db);
console.log('demo account:', acct.ok ? 'ok' : acct.raw.slice(0, 500));
const placed = await placeBracket(db, order);
console.log('placed:', placed.ok, placed.raw.slice(0, 1000));
if (placed.ok && process.argv.includes('--close')) console.log('closed:', (await closePosition(db, symbol)).raw.slice(0, 500));
