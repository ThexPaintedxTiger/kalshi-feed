# Architecture (v1: measurement loop)

Goal of v1: build an honest track record. Every prediction is logged before its market resolves, scored against
the official result, and compared with the simplest possible baseline: the market price itself.

```
every 10 min (GitHub Actions)
 test.mjs      offline math + leakage checks; a failure stops the run
 predict.mjs   Kalshi /markets (single markets closing within 16 days, ~46 pages, ~25 s)
               → keep: resolves in 20 min–6 h, bid>0, spread ≤10¢, volume ≥50, price 3–97¢
               → skip tickers already logged; ≤2 per event (nearest 50¢); round-robin across categories; ≤80 per run
               → predictors: market (mid price), longshot (favorite-longshot hypothesis)
               → EV after fees for YES at ask / NO at 1−bid; simulated pick if EV ≥ 2¢
               → append data/predictions/YYYY-MM.jsonl
 resolve.mjs   tickers past resolution → /markets?tickers= (200 per call) → append data/outcomes.jsonl
               (yes/no only; still unsettled after 7 days → "void", never scored)
 score.mjs     join → scorecard.json
 progress.mjs  scorecard + run heartbeats (data/runs.jsonl) vs config.json goals → progress.json;
               daily snapshot → data/progress.jsonl (trend). Recommends only; never edits config.
 scan.mjs, agents.mjs   dashboard feed (bets.json), unchanged
 dashboard.mjs everything above → dashboard.json (~70 KB) for dashboard.html

Order in the Action: test → resolve → memory → predict → backtest (hourly) → score → progress → scan/agents → dashboard.

## History and memory (added 2026-11-10)
- **backtest.mjs (dev agent)**: lists settled markets (`/markets?status=settled`), takes bid/ask from 1-minute candles
  (`/series/{s}/markets/{t}/candlesticks`) `leadMinutes` before resolution (earliest of close and settlement), applies the same filters
  and predictors (`predictors.mjs`), stores rows with the official result. Walks close-time slices forward to now−1 h and back to
  `days` ago; ≤300 candle calls per hourly run. One market per event (two-sided games are near-duplicates). Never mixed into the live record.
- **memory.mjs**: samples = live outcomes + backtest rows. `recall(series, at)` uses only markets settled before `at` (leak-safe, tested).
  Why no RAG/vector DB: the knowledge is numeric and keyed by series; an exact lookup is cheaper and more reliable than embeddings.
  Revisit semantic search when there are many free-text research notes.
- **memory predictor**: price + (n/(n+shrink)) × the series' past (outcome − price) gap; inactive below `minN` settled samples.
- **import-trades.mjs**: owner's CSV export → `private/my-trades-report.json` (git-ignored). Column names matched by aliases.

## Neural network and paper trading (config v4)
- **nnlib.mjs**: MLP 16 inputs → 16 → 8 → 1 (tanh), P(YES) = sigmoid(logit(price) + output). Output layer starts at 0, so untrained = market.
  Adam, L2 1e-3, mini-batch 32, early stopping. Inputs: price (logit), spread, distance from 50¢, hour of day, category, series memory as of the
  prediction time. Volume is NOT an input: backtest rows only know final volume, which includes trades after the prediction.
- **nn.mjs** (hourly): dataset = backtest rows + resolved live predictions (non-excluded categories). (1) walk-forward: 5 time blocks, train on
  earlier blocks, predict the next unseen block → `data/nn/oos.json` and the honest verdict; (2) holdout curve (early-stopping set — optimistic);
  (3) final model on all data → `data/nn/model.json` (used live by the `nn` predictor). History in `data/nn/train-log.jsonl`.
- **paper.mjs**: goal = grow $10 toward $1,000 over time without risking the account on one bet. Portfolios in `config.json → paper.portfolios`
  (controls: hold cash, coin flip 2%; neural net learned-size and flat 2%; longshot learned-size; memory learned-size).
  Safety for all (`paper.safety`): ≤5% of bankroll per bet including the fee, ≤25% in open bets, halve bets after a 20% drop from peak,
  quarter after 40%. Learned sizing (`paper.learning`): probe bets (1% or $0.25) until 30 bets settle; then up to quarter Kelly × trust, where
  trust = (realized return per $ − 1 SE) ÷ predicted return per $, clipped 0…1; if even realized + 1 SE < 0, the strategy pauses and records
  shadow bets (no money) so it can recover. Buy at ask / 1−bid, per-order fee rounded up, cash locked until settlement.
  Replay never lets the network trade a market it trained on. Monte Carlo: 4,000 bootstrap paths → chance of $1,000 within 250/1,000/3,000 bets,
  chance of ever dropping below $5, bets (and days at the current pace) to 100× from the average growth per bet.
- **Backtest v4**: snapshot 30 min before resolution (hourly markets open only ~1 h before close); one batch candle call prices every market
  in an event; the market nearest 50¢ at the snapshot is kept (same rule as live, no outcome leakage). Sports excluded.

## Watchdog and plain-English status (status.mjs, every run)
Code, not an AI agent: free, exact, same answer every time. Checks every hand-off: recent cloud run, schedule pace (~18 runs/3 h),
predictions logged, outcomes collected, scorecard counts = log, leakage 0, no duplicates, backtest sample unbiased, network trained,
bet-size safety held, paper money adds up. Writes `status.json`: Should I trade? Is it learning? Is it running? What I need from you,
plus a paper watchlist (what the strategies would bet next; not advice). Shown at the top of the dashboard's Agent tab.
Claude subagents are not used in the pipeline (cost and non-repeatable answers); deeper reviews run on request via the skills.

## MCP server (read-only)
`mcp/server.mjs` (official MCP SDK, stdio). Tools: `get_status`, `get_scorecard` (live|backtest), `search_predictions`, `recall_series`, `list_skills`.
- Claude Code: `npm --prefix mcp install`, then it's picked up from `.mcp.json` (approve the project server once).
- Claude Desktop: add to its config `{"mcpServers":{"kalshi-agent":{"command":"node","args":["<full path>/kalshi-feed/mcp/server.mjs"]}}}`.
- Smoke test: `node mcp/test-client.mjs`. Never writes, never calls Kalshi, never reads `private/`.
```

## Why this shape
- **Plain scripts + JSONL in git**: free, auditable, append-only by convention, history in git. No database server.
- **No RAG / vector DB yet**: there are no research documents to search. Add semantic search only when written
  research notes exist and keyword search (`grep`) stops being enough.
- **No MCP servers / agent frameworks**: the pipeline is four deterministic steps; nothing needs tool routing.
- **Code baselines before AI**: if the market price can't be beaten by simple rules, an LLM has to prove it can,
  on the same markets, before it costs anything.

## Prediction row (`data/predictions/*.jsonl`)
`ts` (logged at), `run` (git sha), `cfg` (config version), `ticker`, `event`, `series`, `cat`, `title`, `rules` (first 300 chars),
`resolvesAt`, `leadMin`, `ask`, `bid`, `mid`, `spread`, `askSize`, `bidSize` (raw Kalshi `_fp` sizes), `vol`, `v24`, `oi`,
`est` {predictor: P(YES)}, `picks` {predictor: {side, ev, cost}}, `src` (endpoint @ time). Hypotheses: `config.json` at that `cfg`.

## Scorecard (`scorecard.json`)
Per predictor: Brier and log loss (lower is better), `brierVsMarket` (<0 = better than the market, on the same markets),
calibration table, simulated picks (count, wins, P&L per contract after fees). Every mean has a 95% interval computed
over **events**, not markets (markets in one event are correlated). Verdicts stay "insufficient data" below
`score.minResolved` resolved predictions. `excludedLeakage` counts rows logged after their market resolved (should be 0).

## Configuration (`config.json`)
`scan.*` filters, `predictors.*` (on/off, parameters, hypothesis), `picks.minEdge`, `score.*`. Bump `version` on any change
that affects predictions so results can be split by version.

## Running locally
Node 20+. `node test.mjs && node predict.mjs && node resolve.mjs && node score.mjs`. No keys needed.

## Costs
GitHub Actions minutes are free for public repos. Kalshi public API: ~50 requests per run, plus ≤300 per hour for the backtest. No AI calls in the scored pipeline.
Storage: ~700 bytes per prediction; expect a few MB per month. If it grows too large, gzip old months.

## Limitations (v1)
- Schedule can start 5–30 min late; markets resolving in under ~20 min are skipped on purpose.
- Only price-based predictors so far: no news, sports or weather data yet.
- `resolvesAt` for sports is Kalshi's expected time; games can run long (fine: outcome is checked later).
- One prediction per market (the first time it's seen), so later price moves aren't scored.
- Simulated picks assume you get filled at the quoted ask/bid for 1 contract (depth not modeled).
