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
GitHub Actions minutes are free for public repos. Kalshi public API: ~50 requests per run. No AI calls in v1.
Storage: ~700 bytes per prediction; expect a few MB per month. If it grows too large, gzip old months.

## Limitations (v1)
- Schedule can start 5–30 min late; markets resolving in under ~20 min are skipped on purpose.
- Only price-based predictors so far: no news, sports or weather data yet.
- `resolvesAt` for sports is Kalshi's expected time; games can run long (fine: outcome is checked later).
- One prediction per market (the first time it's seen), so later price moves aren't scored.
- Simulated picks assume you get filled at the quoted ask/bid for 1 contract (depth not modeled).
