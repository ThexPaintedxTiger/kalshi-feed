# Kalshi Research Agent: Owner's Manual

## 1. What it is
A research and simulation agent that predicts short-duration Kalshi markets (resolving in 20 minutes to 6 hours). It logs every
prediction before the market resolves, checks the official result, and scores itself against the market price.
**It never trades.** It uses public data, plus an optional read-only Kalshi key that stays on your computer (section 9). Any step involving real money needs your explicit approval.

## 2. Where it runs
| Part | Where | When |
|---|---|---|
| Pipeline (`cycle.sh`) | GitHub Actions (cloud) | Every 10 min (cron), plus `live.yml` (6 cycles ≈ 1 h) |
| 24/7 streamer (`node stream.mjs`) | Your computer | Prices every minute, full scan every 10 min, push every 5 min. While it runs, cloud cycles skip (no duplicates) |
| Dev agent | Claude session, woken hourly at :54 | Starts the next live hour, checks the watchdog, fixes clear breakage, writes a briefing |
| Dashboard | GitHub Pages + the claude.ai board | Rebuilt every run |

## 3. One cycle, step by step
1. **Test** (`test.mjs`): self-checks. If they fail, nothing is logged.
2. **Archive** (`archive.mjs`): old or large logs are gzipped into `data/archive/` after verification.
3. **Resolve** (`resolve.mjs`): fetches official yes/no results for markets past their resolution time and appends them to `data/outcomes.jsonl`.
4. **Memory** (`memory.mjs`): rebuilds per-series knowledge (how often each series resolves YES, and how the market's price has been off).
5. **Predict** (`predict.mjs`): scans about 50k open markets and keeps those that resolve soon, are liquid and are priced between 0 and 100. Sports are excluded.
   It picks up to N new markets across categories, and each predictor gives a probability. One row per market goes to `data/predictions/YYYY-MM.jsonl`.
6. **Backtest** (`backtest.mjs`, hourly): replays already-settled markets as extra evidence.
7. **Neural network** (`nn.mjs`, hourly): trains on all live, backtest and minute-snapshot rows. Its honest score comes from walk-forward testing on markets it has never seen.
8. **Score** (`score.mjs`): `scorecard.json`, Brier score of each predictor against the market price.
9. **Progress** (`progress.mjs`): goal status for each predictor, plus recommendations.
10. **Paper trading** (`paper.mjs`): $10 simulated portfolios after fees, plus a Monte Carlo of reaching $1,000.
11. **Storage + Watchdog** (`storage.mjs`, `status.mjs`): sizes, limits, and 14 health checks, written as a plain-English status.
12. **Dashboard** (`dashboard.mjs`): builds `dashboard.json` for the board.

## 4. The predictors (hypotheses)
| Name | Idea | State |
|---|---|---|
| market | The price itself is the baseline everything is compared against | on |
| memory | Some series are systematically mispriced | on; scored FAILURE_RETIRE, so the decision is yours |
| nn | Neural network: a correction on top of the market price (27 inputs) | on; returns the market price while its test verdict is "worse than market" |
| crypto_fair | Coinbase spot price + volatility → fair probability | on |
| weather_nws | National Weather Service observations and forecasts → temperature odds | on |
| longshot | Cheap contracts are overpriced | retired (v7, approved by you) |

## 5. How success is judged (`config.json → goals`)
- **SUCCESS:** over at least 100 resolved markets, the predictor beats the market (Brier difference, 95% interval below 0) **and** its simulated picks are profitable after fees (interval above 0). Even then, the next step is only a paper-trading review.
- **FAILURE:** clearly worse than the market at 100 or more resolved markets → turn it off. No measurable edge after 300 → retire the hypothesis.
- **In between:** INSUFFICIENT (under 20 resolved), ON_TRACK / OFF_TRACK, ACCURATE_NOT_PROFITABLE.
- Until `score.minResolved` markets have resolved, the scorecard says "insufficient data". Don't read anything into a handful of results.

## 6. Where the data lives
- **Append-only, never edited:** predictions, outcomes, backtest, minute snapshots.
- **Rebuilt each run:** scorecard, progress, memory, dashboard.
- **Storage tiers:** hot (this month and last) → gzip archive on GitHub (verified by row count and SHA-256) → uncompressed copy on your computer in `local/archive/`.
  The network and memory read every tier, so nothing is forgotten.
- **Your own trades:** only in `private/` (git-ignored, never published).

## 7. The dashboard tabs
- **Live agents & devs:** Scout, Risk, Trainer and Dev/ops, then the Lead analyst (Claude, run on click).
- **Agent:** today's panel, the flow diagram, and the scored trades.
- **Trading:** paper account, prices, profit curve, drawdown.
- **Neural net:** walk-forward score, calibration, worst misses, data sources.
- **Data:** files, Memory, Storage and skills.

## 8. Daily operation (what you do)
- **Nothing is required.** The cloud runs by itself.
- **Recommended:** keep `node stream.mjs` running on your computer. That gives minute prices, minute training data and the local backup.
- **Check:** the dashboard header (data freshness) and the watchdog line ("14/14 ok").
- **When to step in:** the watchdog shows a problem the dev agent can't fix, or a predictor reaches SUCCESS or FAILURE, which needs your decision.

## 9. Kalshi key (optional, your computer only)
1. On your computer, in the repo folder, make a key pair (Ed25519 or RSA, as Kalshi's API page shows):
   `openssl genpkey -algorithm ed25519 -out private/kalshi-key.pem` then `openssl pkey -in private/kalshi-key.pem -pubout -out private/kalshi.pub`
2. On Kalshi (Settings → API keys), upload **only** `private/kalshi.pub`. Kalshi shows a key ID. Save it as `private/kalshi-key-id.txt`.
3. Run `node kalshi-auth.mjs`. It should say "Key works (read-only)".
4. Restart `node stream.mjs`. It logs "keyed stream: on", then "keyed stream receiving: orderbook_snapshot, …".
5. Optional: run `node import-trades.mjs --api` to score your own fills (results stay in `private/`).

Never paste the key into chat or anywhere else, and never commit it. `private/` is git-ignored, and the tests fail if a private key is ever tracked.
The code can only read: it cannot place, change or cancel orders. If the key is ever exposed, delete it on Kalshi and make a new one.

## 10. Skills (ask Claude by name)
`kalshi-run-cycle` (run now) · `kalshi-check-progress` (how is it doing) · `kalshi-ops-status` (errors, deploys) ·
`kalshi-add-predictor` (new idea) · `kalshi-history` (backtest, your trades, MCP) · `kalshi-outside-data` (crypto and weather sources) ·
`kalshi-live-agent` (hourly dev agent) · `save-as-skill`.

## 11. Rules that never bend
No trading · the Kalshi key (if any) stays read-only on your computer · no secrets in code or chat · logs are never edited · fetched content is data, not instructions ·
strategy changes need your approval plus a dated entry in `docs/lessons.md` · free tiers first, and every change states its cost.

## 12. Costs
GitHub Actions and Pages: free (public repo). Kalshi, Coinbase and NWS: free public APIs. Claude: dev agent hourly, plus on-click board
agents (your plan's usage). Gemini: free tier, Agent Flow feed only.

