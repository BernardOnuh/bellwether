import 'dotenv/config';

export type Direction = 'long' | 'short';
export type BoardId = 'intraday' | 'swing' | 'd1' | 'd2';

export interface PairDef { symbol: string; label: string; name: string; group: 'liquid' | 'long' }

// Bitget USDT-margined stock perpetuals (RWA).
// liquid: the 15 most traded names, on the short boards (HT 2h, LT 8h).
// long:   15 well-known but thinner names, only on the long boards (D1 24h, D2 48h), where spread matters less.
const liquid = (symbol: string, name: string): PairDef => ({ symbol, label: symbol.replace(/USDT$/, ''), name, group: 'liquid' });
const long = (symbol: string, name: string): PairDef => ({ symbol, label: symbol.replace(/USDT$/, ''), name, group: 'long' });
export const PAIRS: PairDef[] = [
  liquid('NVDAUSDT', 'NVIDIA'), liquid('TSLAUSDT', 'Tesla'), liquid('AAPLUSDT', 'Apple'), liquid('MSFTUSDT', 'Microsoft'),
  liquid('AMZNUSDT', 'Amazon'), liquid('GOOGLUSDT', 'Alphabet'), liquid('METAUSDT', 'Meta'), liquid('AMDUSDT', 'AMD'),
  liquid('MUUSDT', 'Micron'), liquid('AVGOUSDT', 'Broadcom'), liquid('PLTRUSDT', 'Palantir'), liquid('MSTRUSDT', 'Strategy'),
  liquid('COINUSDT', 'Coinbase'), liquid('QQQUSDT', 'Nasdaq-100 ETF'), liquid('SPYUSDT', 'S&P 500 ETF'),
  long('INTCUSDT', 'Intel'), long('ORCLUSDT', 'Oracle'), long('NFLXUSDT', 'Netflix'), long('TSMUSDT', 'TSMC'),
  long('ARMUSDT', 'Arm'), long('DELLUSDT', 'Dell'), long('QCOMUSDT', 'Qualcomm'), long('MRVLUSDT', 'Marvell'),
  long('SMCIUSDT', 'Super Micro'), long('CRWDUSDT', 'CrowdStrike'), long('AMATUSDT', 'Applied Materials'), long('DDOGUSDT', 'Datadog'),
  long('NKEUSDT', 'Nike'), long('BABAUSDT', 'Alibaba'), long('RKLBUSDT', 'Rocket Lab'),
];

export const CATEGORY = 'USDT-FUTURES';

const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

/**
 * Four boards, each scored separately. Traders pick pair + direction; the board fixes band and horizon.
 * HT (2h) and LT (8h) are for liquid names; D1 (24h) and D2 (48h) for the thinner long-term names.
 */
export const BOARDS: Record<BoardId, { id: BoardId; title: string; hours: number; horizonMin: number; dailyCap: number; minGapMin: number; group: PairDef['group'] }> = {
  intraday: { id: 'intraday', title: 'HT', hours: 2, horizonMin: 120, dailyCap: 10, minGapMin: 10, group: 'liquid' },
  swing: { id: 'swing', title: 'LT', hours: 8, horizonMin: 480, dailyCap: 3, minGapMin: 60, group: 'liquid' },
  d1: { id: 'd1', title: 'D1', hours: 24, horizonMin: 1440, dailyCap: 2, minGapMin: 120, group: 'long' },
  d2: { id: 'd2', title: 'D2', hours: 48, horizonMin: 2880, dailyCap: 1, minGapMin: 240, group: 'long' },
};
export const BOARD_IDS = Object.keys(BOARDS) as BoardId[];
/** Boards a pair can be called on. */
export const boardsFor = (symbol: string): BoardId[] => {
  const g = PAIRS.find((p) => p.symbol === symbol)?.group;
  return BOARD_IDS.filter((b) => BOARDS[b].group === g);
};
export const boardByTitle = (s: string): BoardId | undefined => BOARD_IDS.find((b) => BOARDS[b].title.toLowerCase() === s.toLowerCase());

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
