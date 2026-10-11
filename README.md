<p align="center"><img src="assets/brand/banner-640x360.png" width="640" alt="Bellwether: call US stocks, earn your tier, lead the agent"></p>

# Bellwether

**Call US stocks on Bitget. Earn your tier. Lead the agent.**

Bellwether is a Telegram game for calling US stocks, graded against live prices on Bitget's stock perpetuals. Traders pick a stock and tap Long or Short; the house sets the take-profit, stop and expiry. Every call is graded against live Bitget prices. Traders who keep a 65% win rate share a daily points pool. When several top-tier callers agree, an AI agent proposes the trade, a human confirms it, and it runs on a Bitget **demo** account.

Submitted under **AI Trading Desk**: humans make the calls and confirm every trade; the AI grades, ranks, detects copying, builds consensus and manages risk.

The design follows the fixed-band, confidence-gated scoring of Infinite Quant's Signals Program (Bittensor SN89), adapted to Bitget stock perps, US market hours and a daily 65% reward.

## How a call works

1. **Pick a stock, then tap a button.** For example `⬆️ Long LT ±1.13%`. The tap locks the call at the live Bitget mid price, stamped with Bitget's server time. There are no take-backs.
2. **The house sets the bracket.** Take-profit and stop sit at the same distance from entry (1:1), sized per stock and board: the median move over that board's horizon in the last 30 days, recalibrated daily. Each call freezes the band in force when it was locked.
3. **Grading on 1-minute candles.**
   - ✅ **Win**: take-profit touched first.
   - ❌ **Loss**: stop touched first.
   - ➖ **Wash**: neither by expiry, or both inside the same minute (the order can't be known). Washes don't count toward hit rate.

### Boards

| Board | Expiry | Stocks | Limits |
|---|---|---|---|
| **HT** | 2 hours | 15 liquid: NVDA TSLA AAPL MSFT AMZN GOOGL META AMD MU AVGO PLTR MSTR COIN QQQ SPY | 10/day, 10 min apart |
| **LT** | 8 hours | same 15 | 3/day, 1 h apart |
| **D1** | 24 hours | 15 long-term: INTC ORCL NFLX TSM ARM DELL QCOM MRVL SMCI CRWD AMAT DDOG NKE BABA RKLB | 2/day, 2 h apart |
| **D2** | 48 hours | same 15 | 1/day |

- **Hours:** calls open Monday–Friday, 04:00–16:00 New York time. On Bitget, NVDA's perp trades about $23k a minute in pre-market and regular hours, a third of that overnight, and 54% of weekend minutes have no trades.
- **No weekend holds:** no call may still be running after Friday 20:00 New York time, so D1 calls close Thursday and D2 calls close Wednesday.
- **Listing rule:** a stock is listed on a board only if its band is at least 8× its spread.
- **One open call per stock per board.**

## Scoring

Each board is scored separately.

- **Qualify:** at least 8 wins+losses, and the Wilson lower bound on hit rate (z = 1.28, about 90% one-sided) is at least 50%. Luck doesn't qualify.
- **Tiers:** set on a hit rate shrunk toward 50% with a Beta(6,6) prior.

  | Tier | Shrunk hit rate | Multiplier |
  |---|---|---|
  | ✅ BASE | 55% | 1× |
  | 🎯 SHARP | 60% | 1.2× |
  | 🐺 WOLF | 70% | 2× |

- **Elimination:** after 40+ decisive calls, a lifetime Wilson upper bound below 45% removes the trader.
- **Copy penalty:** every call records whether it landed second, within 15 minutes, on a trade someone else already had open.
  - A trader who shadows **one** established leader (8+ copies of that leader, at least half of their decided calls) is flagged.
  - A flagged trader's copied wins count as losses.
  - Agreeing with different people in a busy moment never flags.
- **Sealed calls:** while a call is open, others see only `sha256(trader, board, stock, direction, entry, band, time, salt)`. The salt is revealed when the call resolves, so anyone can check that nothing changed.

### 🏆 Daily rewards: the 65% club

Every New York trading day at 00:05, after that day's LT calls have resolved, a trader who has finished warmup earns a share of **1,000 points** if:
- their last 20 wins+losses, across all boards, are at least 65% wins (13 of 20),
- they made at least 2 calls that day,
- they aren't flagged as a copier or eliminated.

The pool is split by that day's wins × tier multiplier. Points nobody earns are burned. Consecutive qualifying days build a 🔥 streak.

Why a rolling 20 rather than "65% today": with 5 decided calls a day, a coin-flipper hits 65% on about 1 day in 5, while a trader who really is 65% misses it about half the time. On the rolling-20 rule, a coin-flipper qualifies on about 13% of days and a real 65% trader on about 60%.

## Three ways to play

1. **Telegram bot.** Type `META long LT` or tap through the buttons. You get ✅ ACCEPTED immediately, then ✅ PASS / ❌ FAILED when the call resolves.
2. **Telegram Mini App.** The "Open app" button opens a full app inside Telegram:
   - **Trade:** search stocks, see live prices and bands, pick a board, then Long or Short, then 🔒 Lock.
   - **Calls:** your calls, with PASS / FAILED / pending countdowns.
   - **Club:** your 65% progress ring, warmup, points and streak, plus the weekly board.
   - **Me:** your tier per board.

   Every request is checked against Telegram's signed `initData`, so the app can only ever act as the Telegram user who opened it. It needs a public https URL (`WEBAPP_URL`).
3. **AI agents via the API.** `/apikey new my_agent` in the bot gives a key, and the agent submits calls to `POST /api/v1/calls`. Agents play under exactly the same rules (hours, caps, sealing, warmup, copy detection) and appear as 🤖 on the boards. See [AGENT_API.md](AGENT_API.md) and `scripts/example-agent.ts`.

## Warmup, then the main game

Everyone, human or agent, starts with an **8-day warmup**: 8 days since their first call, with calls on at least 5 different trading days. Warmup calls are graded and build the record, but earn nothing. After warmup, a trader enters the daily 65% club.

## The agent

When qualified traders agree on a stock, board and direction, a **consensus signal** is raised.
- **Agreement:** at least 2 qualified traders within a quarter of the horizon, carrying at least 70% of the weighted vote. Each trader's weight is their shrunk hit rate minus 0.5.
- **Who can vote:** copiers and eliminated traders get no vote.

The agent proposes the trade at the house band, then applies a **risk gate**:
- kill switch,
- at most 3 open trades, one per stock,
- a daily loss limit of 3R,
- no trade into the weekend,
- **skip if fees plus spread exceed 0.25R.** This rules out HT on SPY and QQQ; D1/D2 cost only 0.02–0.08R.

The admin taps **Confirm** in Telegram, and the order goes to Bitget's demo environment through `bgc order … --paper-trading`, with take-profit and stop preset on the exchange and a flatten at expiry. There is **no live-trading code path**. Every `bgc` invocation, including dry runs and failures, is written to the `paper_log` table.

## Architecture

```
Telegram (two taps: stock → Long/Short on a board)
   │
calls.ts    rules: session, weekend, board, caps, gaps · lock at Bitget mid · seal (sha256) · record copy leader
   │                                                              ▲
bands.ts    daily: 30d of 5m candles → median move per board ─────┘   quotes every 30 s
   │
resolve.ts  every 20 s: 1m candles → win / loss / wash
   │
scoring.ts  Wilson gate · shrunk tiers · elimination · copier detection (per leader)
rewards.ts  00:05 NY: 65% club on rolling 20 · 1,000-pt pool by wins × tier · streaks
consensus.ts  qualified agreement → signal
agent.ts    risk gate → Telegram Confirm → executor.ts → bgc --paper-trading
server.ts   dashboard (http://localhost:8787, ?db=sim for the replay)
```

Market data comes from the Bitget v3 public REST API (USDT-FUTURES, RWA stock perps). Storage is SQLite (`node:sqlite`). The code is TypeScript on Node 24, and the bot uses grammY.

## Running it

```bash
npm install
cp .env.example .env     # TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID, Bitget DEMO key
npm test                 # resolver, scoring, sessions, rewards, copy detection, bot flows
npm run bands            # calibrate and print every stock's bands
npm run paper:first      # dry-run one demo order; add -- --send to place it
npm start                # bot + engine + agent + dashboard
npm run simulate         # SIMULATED replay → data/sim.db + results/backtest.json
```

- `SESSION_MODE=always` turns the market-hours calendar off for weekend demos. The bot shows "Demo mode" while it's on.
- `CONSENSUS_MIN_TRADERS` (default 2) can be raised as the crowd grows.

**Bot commands:** `/apikey` (AI agents) · `/pairs` · `/call` (or `/call NVDA long LT`, `/call ORCL short D2`) · `/mycalls` · `/stats` · `/leaderboard` (65% club) · `/tiers` · `/rules` · `/name` · `/myid`. Admin only: `/agent` · `/kill` · `/resume` · Confirm/Reject on proposals.

## Real vs simulated

| Real | Simulated |
|---|---|
| Bitget prices, candles, fees, spreads, instrument rules | The 28 traders in `data/sim.db` (named `sim_trader_NN`) |
| House bands from real 30-day history | Their "skill": with probability *edge*, a sim trader peeks at which side hits first |
| Live calls placed through the Telegram bot | Call timing, clustered around random "moments" per stock |
| Agent orders on the Bitget demo account (`paper_log`) | `results/backtest.json` and the dashboard's replay view |

The dashboard labels the simulated view, and every simulated row carries `simulated = 1`.

## Results (SIMULATED: 21 days, Sep 20 – Oct 11 2026, 30 stocks, 2,682 calls, seed 7)

Average R per trade after fees and spread (1R = the band):

| Board | Follow everyone | Follow tiered callers | Agent on consensus |
|---|---|---|---|
| HT (2h) | −0.166R · 1,206 trades · 56.5% hit | −0.006R · 166 trades · 72.0% hit | +0.338R · 9 trades · 5W 0L |
| LT (8h) | −0.040R · 904 trades · 54.7% hit | **+0.047R** · 74 trades · 66.7% hit | +0.033R · 6 trades · 3W 2L |
| D1 (24h) | −0.089R · 375 trades | no one qualified yet | – |
| D2 (48h) | +0.076R · 197 trades | no one qualified yet | – |

Daily rewards over 15 trading days:
- **Who earned:** the sharp and good sim traders took 70% of the points. They qualified on 47% and 36% of their trading days; coin-flippers on 8%.
- **Copiers:** both were flagged and earned 0.
- **Agent:** the risk gate skipped 5 consensus signals on cost grounds and 2 because the stock was already held.

What this shows, honestly:
1. **Ranking finds skill, and fees decide profit.** Selecting tiered callers lifts the hit rate from about 55% to 67–72%. On HT, that's still only breakeven, because round-trip fees take about 0.2R. On LT it turns positive.
2. **The consensus agent's sample is tiny** (15 trades). It points the right way but proves nothing yet.
3. **D1/D2 need time.** At 1–2 calls a day, nobody reaches 8 decided calls in 21 days. Those boards matter for a real launch, not this replay.
4. **The skill is invented.** These numbers show the machinery working, not that real crowds have an edge. Real calls through the bot are what matter.

## Brand

Light blue on white. Assets live in `assets/brand/`:
- `logo.svg`, `logo-640.png`: the app icon, a white bell with a rising line on a light-blue tile.
- `telegram-profile-640.png`: the bot profile picture.
- `banner-640x360.png`: the bot description picture.
- `mark-mono.svg`: a one-colour bell.

| Token | Light | Dark |
|---|---|---|
| Brand blue | `#2b8fdc` | `#4aa8ee` |
| Ink | `#0b2540` | `#eef6fd` |
| Surface / page | `#ffffff` / `#f2f8fd` | `#0f2236` / `#08182a` |
| Chart series (tiered · consensus · everyone) | `#1f86d6` `#eb6834` `#6250d6` | `#3a97e0` `#d95926` `#9085e9` |

The chart series pass colour-blind separation and contrast checks on both surfaces.

## Known gaps

- No US holiday calendar; weekends only.
- The Bitget demo environment for stock perps hasn't been confirmed end to end yet; it needs a demo API key.
- Trader profiles and trade reasons use templates; an LLM writer isn't built.
- Points aren't redeemable for anything yet.
- The Mini App needs a public https URL. During development, use a Cloudflare quick tunnel.
