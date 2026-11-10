---
name: kalshi-history
description: "Gather and use Kalshi history: run the backtest agent on past settled markets, look up what memory knows about a series, import and score the owner's own Kalshi trades from a CSV export, and query the agent's data through the read-only MCP server. Use when asked about past markets or past bets, backtesting, what we know about a series, the owner's trade history, or to set up/use the MCP tools. Not for live predictions (use kalshi-run-cycle), judging the live record (use kalshi-check-progress) or pipeline errors (use kalshi-ops-status)."
---

# History, memory, your trades, MCP

All free: public Kalshi data and local files. No account access, no keys, no AI calls.

## Backtest past settled markets
```bash
FORCE=1 node backtest.mjs            # hourly in the Action; FORCE runs it now (≤300 candle calls ≈ 90 s)
BT_CALLS=1200 FORCE=1 node backtest.mjs   # one-time bigger backfill (~5 min); be gentle with the API
```
Writes `data/backtest/YYYY-MM.jsonl` and `backtest-scorecard.json`. Settings: `config.json → backtest`.
Rules: prices come from 1-minute candles `leadMinutes` before resolution, never later. Backtest results are
**supporting evidence**; success is judged on the live record (`CLAUDE.md → Goals`). Bump `config.version` if predictors change.

## Memory (series knowledge)
`node memory.mjs` rebuilds `data/memory/series.json` from live outcomes + backtest rows. Read one series:
`node -e 'import("./memory.mjs").then(m=>console.log(m.makeRecall(m.loadSamples())("KXATPMATCH")))'`
The `memory` predictor uses the same lookup, but only with markets settled before the prediction time.

## Owner's own trades
1. The owner exports trade history as CSV from Kalshi and saves it as `private/kalshi-trades.csv`. **`private/` is git-ignored**;
   this repo is public, so never copy that file or its report anywhere else (not into docs, commits, artifacts or chat beyond summaries).
2. `node import-trades.mjs` → `private/my-trades-report.json` (win rate vs average price paid, P&L after fees, by category/series).
3. If columns aren't recognized, it prints the header; add the names to `ALIASES` in `import-trades.mjs`. Sells are not scored yet.
Never ask for Kalshi login details or API keys.

## Neural network and paper portfolios
```bash
FORCE=1 node nn.mjs     # retrain now (hourly in the Action): walk-forward test, holdout curve, final model
node paper.mjs          # rebuild all $10 portfolios + Monte Carlo odds of reaching $1,000
```
Read `data/nn/model.json → oos.verdict` before saying the network is better than the market; anything else is not evidence.
Portfolio results are paper money: report them with the number of settled bets, and say "noise" below ~100.
To add a strategy: add an entry to `config.json → paper.portfolios` (predictor, sizing kelly|fixed, kelly, minEdge, maxFrac).

## MCP server (read-only)
```bash
npm --prefix mcp install     # once
node mcp/test-client.mjs     # smoke test: lists and calls every tool
```
Claude Code loads it from `.mcp.json` (approve the project server when asked). Tools: `get_status`, `get_scorecard`,
`search_predictions`, `recall_series`, `list_skills`. It never writes, calls Kalshi or exposes `private/`.
