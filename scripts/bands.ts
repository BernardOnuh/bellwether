// Recalibrates house bands for every stock pair and prints them.
import { BOARD_IDS, PAIRS, label } from '../src/config.js';
import { openDb } from '../src/db.js';
import { loadBand, loadQuote, refreshBands } from '../src/bands.js';
import { sessionLine } from '../src/sessions.js';

const db = openDb();
await refreshBands(db, process.argv.includes('--force'));
console.log(sessionLine(Date.now()));
console.table(PAIRS.map((p) => {
  const q = loadQuote(db, p.symbol);
  const row: Record<string, unknown> = { pair: label(p.symbol), price: q ? +q.price.toPrecision(6) : null, 'spread bps': q ? +(((q.ask - q.bid) / q.price) * 1e4).toFixed(2) : null };
  for (const b of BOARD_IDS) {
    const x = loadBand(db, p.symbol, b);
    row[`${b} ±%`] = x ? (x.bps / 100).toFixed(2) + (x.listed ? '' : ' ✗') : '-';
    row[`${b} cost R`] = x ? +((2 * 6 + (x.spread_bps)) / x.bps).toFixed(2) : '-';
  }
  return row;
}));
