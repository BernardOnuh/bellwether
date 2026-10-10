// Prints each pair's volatility class and allowed distance band, and stores them in the live DB.
import { PAIRS } from '../src/config.js';
import { openDb } from '../src/db.js';
import { loadProfile, refreshProfiles } from '../src/profile.js';

const db = openDb();
await refreshProfiles(db);
const rows = PAIRS.map((p) => loadProfile(db, p.symbol)!).filter(Boolean).map((p) => ({
  pair: p.pair,
  price: +p.price.toPrecision(6),
  'rv24h %': +(p.rv24h * 100).toFixed(2),
  window: p.volatile ? '30m' : '8h',
  range: +p.typical_range.toPrecision(4),
  'band lo': +p.band_lo.toPrecision(4),
  'band hi': +p.band_hi.toPrecision(4),
  'band %': `${((p.band_lo / p.price) * 100).toFixed(2)}–${((p.band_hi / p.price) * 100).toFixed(2)}`,
  'min dist': +p.min_distance.toPrecision(3),
  closed: !!p.closed,
}));
console.table(rows);
