# Architecture (v2)

One long-running process on the owner's computer does everything; a free cloud job covers for it when it is off.

```
                         Kalshi WebSocket (read-only key, private/)
   orderbook_delta · trade · ticker · market_lifecycle_v2 · cfbenchmarks_value
                                     │  no key / stream down → public REST prices every 30 s
                                     ▼
 live/ws.mjs ──► live/engine.mjs (books, microprice, imbalance, flow, volatility 1/5/30 min; pure, clocked from outside)
                    │ every second
                    ├─ ticks, minute feature rows ─► local/ticks, local/features (gzip, append-only, never pushed)
                    ├─ re-estimate on a 3¢ move or 15 min ─► data/updates/ (never scored)
                    ├─ snapshots at 60/30/15/5 min ─► wait for the outcome ─► data/snapshots/ (training only)
                    └─ settlement message ─► data/outcomes.jsonl ─► refit calib (ms) ─► rescore ─► dashboard
 live/daemon.mjs timers:  scan new markets 10 min · scorecard/dashboard 1 min · outcomes by REST 5 min (fallback)
                          hourly: backtest, walk-forward (nn, calib), ensemble, maker, news/RAG/LLM evals, archive
 live/server.mjs  http://localhost:8787  dashboard + Server-Sent Events (tick 250 ms, health 1 s)
 publish.mjs      main ← data/ every 15 min        site ← site/ every 2 min (one force-pushed commit → GitHub Pages)
```

## One process, shared memory
- `core/store.mjs` loads every log once and afterwards reads only the bytes appended since its last look. A file that shrank or
  vanished (archived, or rewritten by a pull) triggers one clean reload.
- Every step exports `run(ctx)`. `ctx.emit(name, obj)` writes `site/<name>.json` (or `state/`) and keeps the object in memory for
  the next step; `ctx.step` times each step (`state/perf.jsonl`).
- `cycle.mjs → cycle()` is the full sequence (cloud fallback, manual). `derive()` rebuilds every derived file from memory in well
  under a second: score → evals → progress → memory → paper → storage → status → app.json.

## Live layer
- `live/ws.mjs`: one connection; `subscribe` creates one subscription per channel; markets are added/removed with
  `update_subscription` in chunks of 100 as they enter or leave scope. `seq` must rise by one per subscription; a gap on the book
  subscription asks for fresh snapshots (`get_snapshot`). Reconnect with backoff 1 s → 60 s; a socket silent for 30 s is replaced.
  It can only send `subscribe` / `update_subscription` on channels allowed by `kalshi-auth.mjs`.
- `live/engine.mjs`: no I/O and no clock of its own. `onMessage(m, t)`, `onClock(t)`. That makes `live/replay.mjs` exact: the same
  recorded messages and timestamps give the same rows (tested against `tests/fixtures/replay.jsonl.gz`).
- Scope = open logged predictions + the most active unlogged candidates, up to `live.maxMarkets`.
- Health: `site/heartbeat.json` (host, mode `ws`/`rest`, message rate, reconnects, gaps, markets, stale count, `staleTotalSec` =
  seconds with neither the stream nor a recent REST poll feeding prices).
- Alerts (`live/alerts.mjs`): daemon was down > 2 min (raised on restart, and by `start.sh` when the daemon exits), stream down,
  predictor wildly off, model reached SUCCESS, paper drawdown > 20%, LLM spend ≥ 80% of the cap. Sent to ntfy or Discord if
  `private/alerts.json` exists; always recorded in `data/alerts.jsonl`. A switched-off computer cannot alert: the dashboard header
  turns red instead.

## Predictions
`predict.mjs`: discover open markets → filter (resolves in 20 min–6 h, two-sided, spread ≤ 10¢, volume ≥ 50, 3–97¢) → skip logged
tickers → ≤ 2 per event nearest 50¢ → round-robin across categories → features (from the stream when the book is synced, else
public endpoints) → outside data → every enabled predictor → append. Rows carry `ts`, `loggedAt`, `cfg`, quotes, features, `ext`
(outside data with timestamps), `est`, `picks`.

## Models
| Model | What | Trained |
|---|---|---|
| `market` | The mid price. The baseline everything is compared with. | – |
| `calib` | `σ(a·logit(mid) + b + w·x)`, ~15 numbers, L2 toward the market, capped ±0.10 from it. Primary model. | Newton refit on every settlement (ms, warm start); walk-forward hourly. |
| `nn` | Small network, residual on the market, **gated**: returns the market while its walk-forward test says "worse". Challenger. | Fine-tune on settlement; full walk-forward hourly; interval per event. |
| `ensemble` | Logistic blend of calib, nn, crypto_fair and the market; capped ±0.10. | Hourly, only on members' out-of-sample estimates. |
| `crypto_fair` | Random-walk fair value from the settlement reference (CF Benchmarks via the stream, else 3-exchange median) and 1-min volatility. | – |
| `weather_idx` | Average of the settlement index's own airport stations + last-hour trend; σ ≥ 2.5°F; clamp 3–97%. | – |
| `ladder` | Isotonic fit across an event's strikes; differs from the market only where a strike is off the curve. | – |
| `llm` | Local language model reading rules, dated facts and similar past markets; capped ±0.15; ≤ 5 markets per scan. | – |

Training data: resolved live predictions, backtest rows, and minute snapshots; all rows of one market share a total weight of 1;
a row may train a model only for estimates made after its outcome was known (`known < test start`, counted by the leakage eval).

## Evals (the referee)
- `evals/report.mjs` uses the **live record only**. Per model: Brier and log loss vs the market on the same markets, per event;
  by category and lead time; calibration; biggest misses; picks' P&L after fees vs a coin-flip control and cash; a model card.
- `evals/seq.mjs`: empirical-Bernstein confidence sequence (Waudby-Smith & Ramdas 2023). Valid at every moment simultaneously, so
  watching the dashboard cannot create a false SUCCESS. Alpha 0.05 is split across every predictor and variant ever tried.
  Capping a model at ±δ from the market bounds its Brier difference at ±2δ, which makes the test several times faster.
- `evals/leakage.mjs`: seven checks; the total must be 0.
- `evals/llm-eval.mjs`: fixed cases (rules reading, fact extraction incl. a planted prompt injection, the `llm` predictor's Brier);
  reruns when the model or a prompt changes.
- Pipeline tests: `node test.mjs` (all modules; fake socket, fake clock, fake LLM; replay must match exactly).

## Paper trading
`paper.mjs`: $10 taker portfolios with safety caps (≤ 5% per bet, ≤ 25% open, drawdown brakes), learned bet size, cash and coin-flip
controls. `maker.mjs`: one contract resting on each side at the logged best bid/offer, filled only when a later real trade crosses
(queue ahead respected), held to settlement, maker fee always charged. Simulation only.

## LLM and memory
- `llm.mjs`: Ollama by default. Claude (`claude-opus-5-5`, official SDK, optional dependency) only when a caller marks a case as hard
  and valuable, with a key in `private/anthropic-key.txt`, and only while today's spend plus the worst-case cost of the call is under
  `llm.dailyCapUsd`. Calls are cached by input hash and logged in `data/llm-usage.jsonl`.
- `rag.mjs`: local JSONL index (rules, resolved markets, lessons, findings, facts). Every item has `at`; `search(…, { before })`
  returns only earlier items; retrievals for predictions are logged for the leakage eval.
- `agent.mjs`: rules → structure, news → facts, the `llm` predictor, miss explanations, the daily briefing (numbers from code).

## Storage and git
- `main`: code + append-only logs. `site`: derived files, one commit, force-pushed. `state/`, `local/`, `private/`: never pushed.
- `.gitattributes`: `*.jsonl` merge as a union, so the daemon and the cloud fallback can both append.
- `archive.mjs` gzips old months (verified by row count and SHA-256); `storage.mjs` watches sizes and mirrors logs to `local/archive/`.

## Costs
GitHub Actions and Pages: free for a public repo. Kalshi, NWS, exchange and RSS data: free. Local model: free. Claude: at most
`llm.dailyCapUsd` per day (default $1), and $0 unless a key is added.

## Limits to know
- Fills in paper trading assume the quoted price for small size; the maker simulation ignores cancellations ahead in the queue.
- NWS observations are up to an hour old; the weather index is per-minute. A Synoptic token would close that gap.
- The neural-network walk-forward takes ~3 s and runs on the main thread hourly; prices keep buffering and catch up.
- GitHub Pages can lag a force-push by a minute or two and limits build frequency; the header shows the real data age.
