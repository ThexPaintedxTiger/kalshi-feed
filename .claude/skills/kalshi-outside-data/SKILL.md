---
name: kalshi-outside-data
description: "Add or check an outside-data agent for the Kalshi research agent (data not from Kalshi, such as Coinbase crypto prices or National Weather Service observations and forecasts), turning it into a scored predictor and a network input. Use when asked to bring in new information sources, extensions or data feeds for predictions, or to check that the crypto or weather agents are working. Not for Kalshi-only predictors (use kalshi-add-predictor) or pipeline errors in general (use kalshi-ops-status)."
---

# Outside-data agents

Existing: `external/crypto.mjs` (Coinbase, series→product map, random-walk fair value) and `external/weather.mjs` (NWS station observation
+ hourly forecast for 4 hourly-temperature series). Both are free and keyless. Each cycle `predict.mjs` writes `data/external/last.json`
(markets tried/priced per agent); the watchdog checks it.

## Check
`cat data/external/last.json` and the watchdog lines "Outside data: …" in `status.json`. Scorecard predictors `crypto_fair`, `weather_nws`.

## Add a source (one module per source)
1. **Only free/public, permitted data**; state the cost per cycle and a cheaper alternative. Keys go in repo secrets, never in code.
2. Create `external/<name>.mjs` exporting `covers(series)` or a mapping table and `async estimate(m, atMs, series)` →
   `{p, src, ...evidence, at}` or `null`. Use only data published before `atMs` (no future information). Add a mismatch guard if the
   source might describe a different asset or place than Kalshi settles on (see the HYPE note in `crypto.mjs`).
3. Wire it in `predict.mjs` (the outside-data loop) and, if the source has history, `backtest.mjs`.
4. Add a predictor in `predictors.mjs` (`c => c.ext?.<name>?.p ?? null`) and in `config.json → predictors` with its hypothesis; bump
   `config.version`. Update `outside()` in `nnlib.mjs` if the network should see it.
5. Tests in `test.mjs` for the probability math and the mapping; then run `kalshi-run-cycle`.
6. Judge it only by the scorecard (live) and backtest verdicts against the market price; never by a few results.
