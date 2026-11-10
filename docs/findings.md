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

## 2026-11-10 — History endpoints and first backtest
- `/markets?status=settled&min_close_ts&max_close_ts` lists settled markets with `result`; ~50k settled single markets closed in a 6 h window (most illiquid).
- `/series/{series}/markets/{ticker}/candlesticks?start_ts&end_ts&period_interval=1|60` returns `yes_bid`/`yes_ask` OHLC per period: historical
  quotes at any past minute. `/historical/markets` and `/markets/trades` also exist (not used yet).
- Candle yield: only ~25% of liquid settled markets have a two-sided quote within 10¢ spread an hour before close; many open less than an hour before close.
- ~~First backtest (302 markets)~~ **Retracted**: its sample was biased by outcome-dependent selection (see lessons.md). Rebuilt in config v3.

## Hypotheses to test (not yet evidence)
- *Series memory*: a series' past gap between outcome and price persists. Predictor `memory` (minN 10, shrink 20). Needs history to activate.
- *Favorite-longshot bias*: cheap contracts win less often than their price implies. Predictor `longshot` (slope 1.1).
  Published research on Kalshi reports this bias; our own data will confirm or reject it for short markets.
