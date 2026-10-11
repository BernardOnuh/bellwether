import 'dotenv/config';

export type Direction = 'long' | 'short';
export type BoardId = 'intraday' | 'swing';

export interface PairDef { symbol: string; label: string; name: string }

// Bitget USDT-margined stock perpetuals (RWA). Chosen for liquidity and tight spreads.
export const PAIRS: PairDef[] = [
  { symbol: 'NVDAUSDT', label: 'NVDA', name: 'NVIDIA' },
  { symbol: 'TSLAUSDT', label: 'TSLA', name: 'Tesla' },
  { symbol: 'AAPLUSDT', label: 'AAPL', name: 'Apple' },
  { symbol: 'MSFTUSDT', label: 'MSFT', name: 'Microsoft' },
  { symbol: 'AMZNUSDT', label: 'AMZN', name: 'Amazon' },
  { symbol: 'GOOGLUSDT', label: 'GOOGL', name: 'Alphabet' },
  { symbol: 'METAUSDT', label: 'META', name: 'Meta' },
  { symbol: 'AMDUSDT', label: 'AMD', name: 'AMD' },
  { symbol: 'MUUSDT', label: 'MU', name: 'Micron' },
  { symbol: 'AVGOUSDT', label: 'AVGO', name: 'Broadcom' },
  { symbol: 'PLTRUSDT', label: 'PLTR', name: 'Palantir' },
  { symbol: 'MSTRUSDT', label: 'MSTR', name: 'Strategy' },
  { symbol: 'COINUSDT', label: 'COIN', name: 'Coinbase' },
  { symbol: 'QQQUSDT', label: 'QQQ', name: 'Nasdaq-100 ETF' },
  { symbol: 'SPYUSDT', label: 'SPY', name: 'S&P 500 ETF' },
];

export const CATEGORY = 'USDT-FUTURES';

const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

/** Two boards, scored separately. Traders pick pair + direction; the board fixes band and horizon. */
export const BOARDS: Record<BoardId, { id: BoardId; title: string; horizonMin: number; dailyCap: number; minGapMin: number }> = {
  intraday: { id: 'intraday', title: 'Intraday (2h)', horizonMin: 120, dailyCap: 10, minGapMin: 10 },
  swing: { id: 'swing', title: 'Swing (8h)', horizonMin: 480, dailyCap: 3, minGapMin: 60 },
};
export const BOARD_IDS = Object.keys(BOARDS) as BoardId[];

/**
 * US equity session for calls (America/New_York). Bitget's stock perps trade around the clock,
 * but outside pre-market + regular hours they are thin, and weekends are mostly empty minutes.
 * SESSION_MODE=always disables the calendar (for demos only; it is shown in the bot and dashboard).
 */
export const SESSION = {
  mode: (process.env.SESSION_MODE ?? 'us') as 'us' | 'always',
  openMin: 4 * 60,          // 04:00 ET, pre-market
  closeMin: 16 * 60,        // 16:00 ET, regular close; last moment to lock a call
  weekendCutoffMin: 20 * 60, // Friday 20:00 ET: no call may still be running after this
};

/** House bands: one symmetric 1:1 band per pair and board, recalibrated daily, frozen into each call at lock. */
export const BANDS = {
  volWindowDays: 30,
  strideMin: 30,           // sample a window start every 30 min inside the session
  minSpreadMultiple: 8,    // list a pair on a board only if band >= 8x its spread
  maxAgeMs: 26 * 3600_000,
};

export const RULES = {
  takerFee: 0.0006,
  staleTickerMs: 5_000,
};

/** Scoring, modeled on a confidence-gated hit rate with tiers. */
export const SCORING = {
  qualifyMinDecisive: num('QUALIFY_MIN_DECISIVE', 8),
  qualifyZ: 1.2816,         // one-sided ~90%
  qualifyLbFloor: 0.5,      // Wilson lower bound must clear a coin flip
  tierPriorK: 12,           // Beta(6,6) shrinkage toward 50% before tiering
  tiers: [
    { name: 'WOLF', min: 0.7, mult: 2 },
    { name: 'SHARP', min: 0.6, mult: 1.2 },
    { name: 'BASE', min: 0.55, mult: 1 },
  ],
  reputationDays: 60,
  reputationMaxDecisive: 100,
  pointsDecayDays: 7,       // each win's points fade linearly to zero over 7 days
  winCap: 20,               // at most 20 wins count toward points
  warmupDays: num('WARMUP_DAYS', 8), // wins in the first days build the record but earn no points
  elimMinDecisive: 40,
  elimUbCeil: 0.45,         // eliminated when lifetime Wilson upper bound < 45%
  copyLagMin: 15,           // same pair+direction+board within 15 min of an open call = landed second
  copyHabitualShare: 0.5,
  copyMinCopies: 8,
  copyLeaderMinDecisive: 10,
};

/**
 * Daily rewards ("65% club"): each trading day, traders whose last 20 wins+losses are >= 65% and who made
 * at least 2 calls that day split a fixed points pool, weighted by that day's wins x tier. Unclaimed points burn.
 */
export const REWARDS = {
  minRate: num('REWARD_MIN_RATE', 0.65),
  rollingDecisive: 20,
  minCallsToday: 2,
  dailyPool: num('REWARD_DAILY_POOL', 1000),
  settleDelayMin: 5,        // settle 00:05 New York, after the day's swing calls have resolved
};

export const CONSENSUS = {
  minTraders: 3,
  minAgreement: 0.7,
  lookbackFrac: 0.25,       // look back a quarter of the horizon (30 min intraday, 2h swing)
};

export const AGENT = {
  mode: (process.env.AGENT_MODE ?? 'confirm') as 'confirm' | 'paper',
  riskUsdt: num('AGENT_RISK_USDT', 10),
  maxOpen: 3,
  dailyLossLimitR: 3,
  maxCostR: 0.25,           // skip trades where fees + spread exceed a quarter of the band
  confirmTimeoutMs: 3 * 60_000,
};

export const pairByLabel = (s: string) =>
  PAIRS.find((p) => p.label.toLowerCase() === s.toLowerCase() || p.symbol.toLowerCase() === s.toLowerCase());
export const pairBySymbol = (s: string) => PAIRS.find((p) => p.symbol === s);
export const label = (sym: string) => pairBySymbol(sym)?.label ?? sym.replace(/USDT$/, '');
