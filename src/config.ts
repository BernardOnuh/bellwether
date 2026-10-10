import 'dotenv/config';

export type Direction = 'long' | 'short';

export interface PairDef {
  symbol: string;   // Bitget USDT-FUTURES symbol
  label: string;    // what traders type / see
  kind: 'crypto' | 'stock';
}

// USDT perpetuals: liquid, tight spreads, and shorts are possible. Stocks are Bitget's RWA perps.
export const PAIRS: PairDef[] = [
  { symbol: 'BTCUSDT', label: 'BTC', kind: 'crypto' },
  { symbol: 'ETHUSDT', label: 'ETH', kind: 'crypto' },
  { symbol: 'SOLUSDT', label: 'SOL', kind: 'crypto' },
  { symbol: 'XRPUSDT', label: 'XRP', kind: 'crypto' },
  { symbol: 'DOGEUSDT', label: 'DOGE', kind: 'crypto' },
  { symbol: 'NVDAUSDT', label: 'NVDA', kind: 'stock' },
  { symbol: 'TSLAUSDT', label: 'TSLA', kind: 'stock' },
  { symbol: 'MSTRUSDT', label: 'MSTR', kind: 'stock' },
];

export const CATEGORY = 'USDT-FUTURES';

const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

export const RULES = {
  // Volatility classifier: trailing 24h realized vol (daily, from 5m closes) at or above this => volatile
  volThreshold: num('VOL_THRESHOLD', 0.015),
  volatileWindowMin: 30,
  calmWindowMin: 8 * 60,
  // Allowed distance band as multiples of the pair's typical range for its window
  bandLo: 0.5,
  bandHi: 1.5,
  // Minimum distance = costMultiple x round-trip cost (2x taker fee + spread)
  costMultiple: 3,
  takerFee: 0.0006,
  // Spam / hedging limits
  dailyCap: num('DAILY_CAP', 10),
  // Entry lock
  staleTickerMs: 5_000,
  profileMaxAgeMs: 2 * 60 * 60 * 1000,
  // Market treated as closed when this share of the last 30 1m candles had zero volume
  closedZeroVolShare: 0.8,
  // Scoring
  priorWins: 5,
  priorTotal: 10,
  minDecided: num('MIN_DECIDED', 10),
  // A wash rate this far above the crowd's own wash rate starts to cost rank (closes the huge-target loophole
  // without punishing everyone for washes that 1:1 brackets produce by design).
  washSlack: 0.1,
  washPenalty: 1,        // rank multiplier slope above (crowd wash rate + washSlack)
};

export const CONSENSUS = {
  minTraders: 3,          // independent qualified traders on the same side
  minAgreement: 0.7,      // share of weight on the winning side
  windowFrac: 1 / 3,      // look-back = window x this (10 min for 30m pairs, 160 min for 8h)
  corrMinOverlap: 5,      // co-calls needed before judging two traders as clones
  corrMaxAgree: 0.9,      // above this agreement they count as one voice
  corrNearMs: 5 * 60_000,
};

export const AGENT = {
  mode: (process.env.AGENT_MODE ?? 'confirm') as 'confirm' | 'paper',
  riskUsdt: num('AGENT_RISK_USDT', 10),
  maxOpen: 3,
  dailyLossLimitR: 3,
  confirmTimeoutMs: 3 * 60_000,
};

export const pairByLabel = (s: string) =>
  PAIRS.find((p) => p.label.toLowerCase() === s.toLowerCase() || p.symbol.toLowerCase() === s.toLowerCase());
export const pairBySymbol = (s: string) => PAIRS.find((p) => p.symbol === s);
