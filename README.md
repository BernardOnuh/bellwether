# Crowd-Signal Trading Agent

Traders make simple directional calls in Telegram. The system scores every call against real Bitget prices, ranks traders on a shrunk hit rate that can't be gamed, and looks for moments when the best-ranked traders agree. When they do, an agent proposes a trade, checks it against a risk gate, and sends it to Bitget's **demo** environment after a human taps Confirm.

Submitted under **AI Trading Desk**. The AI cleans, scores, and builds consensus; humans make the calls and confirm every trade.

## Call rules

A trader picks only the **pair**, the **direction**, and a **distance** in price points. The bot sets the rest:

| | |
|---|---|
| Entry | Mid price at the moment the trader taps **Lock**, stamped with Bitget's server time |
| Target | Entry ± distance, in the called direction |
| Stop | The same distance against the call (1:1, so the breakeven hit rate is 50% before costs) |
| Expiry | 30 min if the pair's trailing 24h realized vol ≥ 1.5%/day, otherwise 8 h |

**Outcomes** are resolved on 1-minute candles. A **win** means the target was hit first, and a **loss** means the stop was hit first. A **wash** means neither was hit by expiry, or both were hit inside the same 1-minute candle, where the order can't be known. Washes are excluded from the hit rate.

**Ranking:** `(wins + 5) / (wins + losses + 10)`. A trader needs 10 wins plus losses to qualify.

**Loopholes closed**

- *Huge targets that never resolve:* distances must sit within 0.5x–1.5x of the pair's typical move for its window. The typical move is the median of `max(high − open, open − low)` per window over the trailing 7 days. A wash rate more than 10 points above the crowd's own wash rate also lowers rank.
- *Tiny targets that are just noise:* the minimum distance is 3x the round-trip cost (2 × taker fee + spread).
- *Hedging and spam:* one open call per pair per trader, and 10 calls per day.
- *Stale or closed markets:* a call is rejected when the ticker is stale, or when 80% of the last 30 one-minute candles had no volume.

## Architecture

```
Telegram (/call → pair → direction → distance → Lock)
   │
   ▼
calls.ts ── rule checks, entry lock at server time ──► SQLite (data/live.db)
   ▲                                                     │
profile.ts  every 5 min: realized vol → window,          │
            typical move → distance band                 │
                                                         ▼
resolve.ts  every 20 s: 1m candles → win / loss / wash ──► scoring.ts (shrunk hit rate, wash penalty)
                                                         │
consensus.ts  qualified traders, same pair + side within ⅓ window,
              weight = rank − 0.5, clones collapsed, ≥3 traders, ≥70% weight
                                                         │
agent.ts  risk gate (kill switch, max 3 open, 1 per pair, −3R daily stop)
          → Telegram Confirm → executor.ts → `bgc order … --paper-trading`
          → TP/SL preset on the exchange, flatten at expiry
                                                         │
server.ts  dashboard: leaderboard, call feed, signals, agent trades, headline chart
```

- **Market data:** Bitget v3 public REST (`/api/v3/market/*`), USDT perpetuals. The stock pairs (NVDA, TSLA, MSTR) are Bitget's RWA perps. The tokenized spot stocks trade too thinly to score calls against.
- **Execution:** Bitget Agent Hub's `bgc` CLI (`@bitget-ai/bitget-agent-cli`), always run with `--paper-trading`. There is no live-trading code path. Every invocation, including dry runs and failures, is written to the `paper_log` table.
- **Pairs:** BTC, ETH, SOL, XRP, DOGE, NVDA, TSLA, MSTR (all `…USDT` perps).

## Running it

```bash
npm install
cp .env.example .env            # Telegram token, your Telegram id, Bitget DEMO key
npm test                        # resolver + scoring unit tests
npm run profiles                # live volatility class and distance band per pair
npm run paper:first             # dry-run one demo order; add -- --send to place it
npm start                       # bot + resolver + consensus agent + dashboard (http://localhost:8787)
npm run simulate                # SIMULATED replay → data/sim.db + results/backtest.json
```

Telegram commands: `/call` (or `/call BTC long 600`), `/mycalls`, `/stats`, `/leaderboard`, `/pairs`, `/rules`. Admin-only: `/agent`, `/kill`, `/resume`, plus Confirm/Reject buttons on agent proposals.

## Real vs simulated

| Real | Simulated |
|---|---|
| Bitget prices, candles, fees, spreads | The 30 traders in `data/sim.db` (named `sim_trader_NN`) |
| Live calls placed through the Telegram bot | Their "skill": with probability *edge* a sim trader peeks at which side hits first |
| Agent orders on the Bitget demo account (`paper_log`) | Their call timing, clustered around random "moments" per pair |
| | The headline chart and `results/backtest.json` |

The dashboard labels the simulated view, and every simulated row carries `simulated = 1`.

## Results so far (SIMULATED, 7 days, 2026-10-03 → 2026-10-10, seed 42)

| Strategy | Trades | Hit rate | Washes | Avg R / trade (after costs) |
|---|---|---|---|---|
| Agent following top-ranked consensus | 31 | 61.5% | 58% | −0.32 |
| Follow top-5 ranked traders individually | 233 | 56.7% | 55% | −0.24 |
| Follow everyone | 2,218 | 54.1% | 61% | −0.23 |

What this shows, honestly:

1. **Ranking finds skill.** The three "sharp" sim traders rank 1st, 4th, and 16th. The two wash-gamers and two "faders" end up in the bottom ten.
2. **Consensus raises the hit rate** from 54% to 61.5%, but the sample is small (13 decided trades).
3. **Costs win anyway.** With taker fees of 0.06% per side plus spread, a 30-minute bracket on SOL or DOGE pays about a third of R in costs. Washes, which are about 55–60% of 1:1 brackets by construction, still pay the full cost. No strategy here is profitable after costs.
4. **The skill in this replay is invented**, so these numbers show that the plumbing works, not that real crowds have edge. Real call data is what matters.

Levers that this data points to, not yet built: maker entries, trading only the 8h pairs, or a narrower band (e.g. 0.3x–1.0x) to cut washes.

## Open questions

- Will the hackathon accept a short paper-trading log under AI Trading Desk?
- Bitget's demo environment for stock perps (NVDA/TSLA/MSTR) is untested until a demo key is in place.
