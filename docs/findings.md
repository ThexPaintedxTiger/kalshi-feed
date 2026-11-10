# Findings

Dated, sourced observations. Facts here are verified unless marked *hypothesis*.

## 2026-11-10 — Kalshi API and market supply
- Source: live calls to `api.elections.kalshi.com/trade-api/v2` at ~15:55 UTC.
- `/markets` without `mve_filter=exclude` within 14 days: >80,000 rows (cap hit), mostly multi-leg combos. With it: ~45,500 rows in 46 pages, ~23 s.
- Sports `close_time` is ~14 days after the game; `expected_expiration_time` is the game time. Using `close_time` alone finds 0 sports markets within 6 h.
- About 360 markets resolve in 20 min–6 h and pass the liquidity filters at a time like this (US morning, Tuesday): tennis, esports,
  college basketball, index ranges (S&P, Nasdaq), crypto hourly, commodities, weather.
- Settled markets return `result: "yes"|"no"` and `settlement_ts`; a 200-ticker batch lookup works.
- Old pipeline: of the top 150 dashboard markets only 11 closed within 24 h; picks had no ticker and were overwritten hourly, so nothing could be scored.

## Hypotheses to test (not yet evidence)
- *Favorite-longshot bias*: cheap contracts win less often than their price implies. Predictor `longshot` (slope 1.1).
  Published research on Kalshi reports this bias; our own data will confirm or reject it for short markets.
