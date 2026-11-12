# Handoff note — v2, 2026-11-12

## State
- `main` = v2 (config v13). Tests: `node test.mjs` passes (≈ 5 s, offline; fake socket, fake clock, fake LLM, replay fixture).
- Live record: 1,433 resolved markets. **Nothing beats the market** (market Brier 0.1436). Leakage eval: 0.
  - `nn` 742 resolved, +0.0000 vs market → NO_EDGE (it copies the price). `crypto_fair` 192 resolved, +0.0023.
  - `calib`, `ensemble`: 20 resolved each (too early). Walk-forward on 2,700 past markets: calib +0.0006, ensemble +0.0015 (slightly worse).
  - `weather_idx`, `ladder`, `llm`: no resolved rows yet.
  - Maker paper portfolio: 118 of 160 resting orders filled, 44 won, −8.5¢ per fill after fees. Being filled is bad news on these markets.
- Published: `site` branch exists and is updated by every run. **GitHub Pages is not enabled yet** (URL returns 404): owner step in
  `docs/manual.md` §1.5.

## Verified here vs not verified
| Claim | Status |
|---|---|
| Pipeline in one process, derived files off `main`, `site` branch push | Verified with real cycles in the cloud |
| Stream client: subscribe, add/remove markets, seq-gap resync, reconnect with backoff, silent-socket watchdog | Verified against a fake socket and fake clock |
| Forced disconnect auto-recovers; SSE delivers a price change in < 1 s | Verified in the daemon end-to-end test (fake socket, real HTTP) |
| Replay reproduces logged estimates | Verified on a fixture built from public data |
| Daemon runs on real data | Verified for 3–6 minutes in REST mode (no key in the cloud) |
| **Authenticated WebSocket against real Kalshi** | **Not verified.** Message formats follow docs.kalshi.com as read on 2026-11-12. First real start is the test. |
| **24 h unattended, < 1 min total staleness** | **Not verified.** Needs the owner's computer. Read `staleTotalSec` and `ws.reconnects` in the heartbeat. |
| Ollama models, embeddings, real LLM eval numbers | **Not verified** (no Ollama in the cloud). `node llm.mjs` on the owner's computer. |
| Claude escalation through the SDK | **Not verified live** (no key here). Request shape follows the SDK docs; tested with a fake client. |
| Alerts reaching a phone | **Not verified** (no webhook). `node live/alerts.mjs "Test" "hello"`. |

## First things to check after the owner starts it
1. Console line `stream: live` and, within a minute, `watching N markets`. If it logs `stream error <code>` right after subscribing,
   the likeliest causes are a channel name or parameter Kalshi changed: see `live/ws.mjs` (`PER_MARKET`, `subscribeAll`) and
   `docs/findings.md`. `cfbenchmarks_value` and `market_lifecycle_v2` are subscribed separately so one failing does not block books.
2. Record a day for a real replay fixture: start once with `RECORD_RAW=1`, then `node live/replay.mjs local/raw/<day>.jsonl.gz`.
   Replace `tests/fixtures/replay.jsonl.gz` with a trimmed real recording (`tools/make-replay.mjs` shows the format).
3. Outcomes should arrive with `via: "ws"`. If they all say `rest`, the lifecycle messages' field names differ from the docs
   (`live/engine.mjs`, the `market_lifecycle_v2` branch).
4. Pages URL returns 200 and the header shows data under 2 minutes old. If GitHub throttles Pages builds, raise
   `publish.siteEveryMinutes`; the header always shows the true age.

## Open items (not built, on purpose)
- **Synoptic token for weather.** NWS observations are up to an hour old; the index is per-minute. With a free Synoptic token in
  `private/`, `external/weather.mjs → stationObs` can read the HF-ASOS one-minute series (`<station>1M`, network 258) the index uses.
- **Indices and commodities** (S&P/Nasdaq hourly, gold, WTI): need a futures-vs-cash basis model and an official close source.
  Start with `KXINXU`/`KXNASDAQ100U` using the same random-walk form as `crypto.mjs` on index futures; score it on its own.
- **Economic-release calendar** (BLS, BEA, Fed, EIA schedules): a feature "minutes to the next scheduled release", from the
  agencies' own calendars. BLS blocks plain fetches (HTTP 403): use the calendar .ics or FRED.
- **News facts as a model input.** Facts are stored and retrievable but are not an input to `calib`. Adding one is a counted variant.
- **Sports shadow test.** Still excluded from scoring by the owner's earlier choice; shadow-logging them (flagged rows kept out of
  portfolios) would show whether the exclusion costs anything.
- **Playwright scraping** was not needed: every source so far has an API or a feed.
- **Network training in a worker thread** if the 3-second hourly pause ever matters.
- Outside the repo, for the owner: the repo secret `GEMINI_API_KEY` is no longer read (delete it); the disabled scheduled task
  `trig_01VBpUdvVfLrxySgxCPLceHk` and the two old claude.ai artifacts are obsolete.

## How to continue safely
- Read `CLAUDE.md` first. Decisions go in `docs/lessons.md` and `data/decisions.jsonl`; verified facts in `docs/findings.md`.
- New idea → `kalshi-add-predictor`. Count every variant. Tune only on data settled before `config.evals.frozenAt`.
- Never run a cycle against `main` from a second machine while the daemon's heartbeat is fresh.
- A good result is a system that would recognise an edge. Today's honest answer is "no edge", and the dashboard says so.
