# Lessons

What we changed because the data (or a mistake) taught us something. Newest first.

- 2026-11-10: Adding the 30-minute price move (2 more inputs) made the network worse than the market on unseen markets (Brier +0.010,
  95% range +0.002…+0.018). A smaller, more cautious network (8→4 hidden, lr 0.003, L2 0.01), chosen once on principle, was still worse
  (+0.004). We stopped tuning (trying settings until one passes would overfit the test) and added a gate: while the walk-forward verdict is
  "worse than market", the live network predictor returns the market price. It retrains hourly and re-enables itself.

- 2026-11-10: The coin-flip control's lucky run produced a "16.6% chance of $1,000" in the Monte Carlo. Bootstrapping a lucky sample extrapolates luck; the simulation now shifts past results down by one standard error of their mean.
- 2026-11-10: The dashboard said "pipeline OK" while the schedule had never fired (local runs counted). The header now shows data age and turns stale after 30 minutes.

- 2026-11-10: Owner clarified the goal: $10 → $1,000 over time by betting smartly, not a moonshot. Removed full/half-Kelly portfolios; added hard
  caps (5% per bet, 25% open), drawdown brakes, learned bet size and pause-on-proven-loss. Found while testing: a 1% probe on $10 is below the
  $0.10 minimum order, so a learning strategy never traded; probe floor set to $0.25. The 5% cap first ignored the fee (5.2%); it now includes it.

- 2026-11-10: On pure noise, the network's early-stopping validation loss still beat the market (0.636 vs 0.642), because the same set chose
  the epoch. Only the walk-forward score on later, never-seen markets is used as the network's verdict.
- 2026-11-10: Hourly crypto/index markets open ~1 h before close, so a 60-min snapshot found no prices (730 skipped). Snapshot moved to 30 min.
- 2026-11-10: Owner asked to steer away from sports. Note: the data had not shown sports to be less predictable (market Brier 0.168 on 285
  sports markets; other categories had too few samples to compare). Excluded by preference, revisit with data.

- 2026-11-10 (**leak caught**): Backtest v1 picked the most-traded market per event. The eventual winner's market gathers the most
  volume, so the sample was tilted toward YES (YES won 55% vs 45.6% average price over 302 markets). Memory learned that false gap and
  the live memory predictor made 11 YES picks in config v2. Fix (config v3): choose markets within an event by a fixed ticker hash and judge
  liquidity per event; backtest v1 data was discarded (still in git history); every backtest now reports `sampleCheck` and warns on a
  gap > 5 points. Config-v2 live rows stay as logged (never edited) and are labeled `cfg: 2`. Lesson: **any selection rule that uses
  data from after the prediction time is leakage, even if it's only used to choose which markets to study.**

- 2026-11-10: The dashboard hid a render error behind "couldn't load data" (one try/catch around fetch and render). Fetch and render errors are now separate and shown.
- 2026-11-10: A predictor that can't act yet (memory with no history) scored "no measurable difference", which reads like a finding. Added verdict "same as market (not active yet)".
- 2026-11-10: Backtest picked both sides of two-way games; they're near-duplicates. Now one market per event in the backtest.

- 2026-11-10: An unquoted skill description containing ": " broke its YAML front matter; caught by the parse check. Always quote descriptions.

- 2026-11-10: Ranking only by volume filled 75 of 80 slots with sports. Now round-robin across categories.
- 2026-11-10: Without a ticker and an append-only log, picks can never be scored. Log first, analyze later.

- 2026-11-10 (**strategy change, owner approved**): Retired the `longshot` predictor (config v7). Evidence: 832 resolved live markets,
  Brier vs market +0.0006 (95% interval −0.0006 … +0.0019), 0 picks; backtest 1,334 markets, −0.0002, no measurable difference.
  Status was FAILURE_RETIRE (no edge after `retireAfter` resolved). `on: false` stops new estimates; past rows stay in the logs and its
  final record stays in the scorecard, labelled RETIRED and excluded from the overall goal. The `longshot-learn` paper portfolio was removed.
  Lesson: a published bias (favorite-longshot) didn't show up in short Kalshi markets at a measurable size; the price already absorbed it.
- 2026-11-10 (**forgetting bug caught**): `predictionFiles()` only returned this month and last month, and `allPredictions()` used it, so memory,
  the network and paper trading would have silently dropped live data older than ~2 months. Now the readers use `allMonthFiles()` (hot + archive);
  `predictionFiles()` stays for de-duplication/resolving only. Lesson: any "recent files" shortcut must never feed learning or scoring.
- 2026-11-10: Network inputs 20 → 23 (config v8): minute volatility over 30 min (+ flag) from the same 1-minute candles already fetched, and time
  left to resolution. Minute snapshots from the streamer join training only. No result claimed; the walk-forward verdict decides.
- 2026-11-10: Dashboard trimmed from 8 tabs to 5 (Profit & loss → Trading, Trades → Agent, Skills → Data). Old links (#pnl, #trades, #skills) still work.
- 2026-11-11: Cleanup. Shared helpers moved to `lib.mjs` (`marketUrl`, `mean`, `LOG_KINDS`, `readLog`, `predictionRows`); `scan.mjs` and the
  MCP server now use the pipeline's own Kalshi fetch and log readers instead of copies. Found 7 markets logged twice (a local streamer test overlapped a
  cloud run, 2026-11-10 23:45 UTC). Rows were not deleted; every reader now counts the first logged row per market and the watchdog reports repeats.
  Lesson: a local test run must not log predictions while the cloud is running (use `SKIP_SAVE=1`/a copy), and readers must not trust "one row per ticker".
- 2026-11-11: Owner approved an optional Kalshi API key, owner's computer only (`private/`), read-only by construction (`kalshi-auth.mjs`:
  GET allowlist + market-data channels; orders throw before signing; tests check this, Ed25519 and RSA signatures, and that no private key is tracked).
  Network inputs 23 → 27 (config v9): order-book imbalance and 30-min trade flow. Live rows get them from public endpoints (no key) so the
  walk-forward test can judge them; the keyed stream adds them to minute snapshots. Expectation before data: small chance of a real edge (~10%, estimated).

## v2 decisions (the agent decides everything except real money; owner's rule of 2026-11-12). Newest last.

- 2026-11-12 (**config v10: weather_nws OFF**). What: `predictors.weather_nws.on = false`; `weather-learn` paper portfolio removed.
  Why: +0.335 Brier vs market, 4 of 30 paper wins. The rows show one NWS airport station (e.g. KMDW 60.8°F) while the forecast said 54°F and
  the market priced "≥53°" at 0.14: the station is not what Kalshi settles on. The rules name **Synoptic Data, "Kalshi Weather Index
  Methodology"** for a metro area (contract `CHIMETROWINDEX`), i.e. an index, not one airport. σ ≈ 1.2°F and a 0.995 clamp turned that
  source error into near-certain wrong bets. Undo: set `on: true` (do not, until the rebuild passes its regression test on the logged rows).
- 2026-11-12 (**config v10: memory predictor OFF**). Why: 1,164 resolved live markets, Brier vs market +0.0031 (worse), backtest +0.0001.
  `memory.mjs` stays: its per-series history is an input to the models. `memory-learn` portfolio removed. Undo: `on: true` + restore `PRED.memory` from git.
- 2026-11-12 (**network interval per event**). The walk-forward 95% interval in `nn.mjs` treated every market as independent. It now uses
  `score.mjs → clustered()` (per-event means). On 2,257 unseen markets in 1,478 events: diff 0.0000, −0.0002…+0.0002 → no measurable difference
  (the network is copying the market). Undo: none needed; the old interval was wrong.
- 2026-11-12 (**one process, logs loaded once**). `core/store.mjs` reads only bytes appended since the last look; every step exports
  `run(ctx)` and shares memory (`cycle.mjs`). Measured: derived steps (score, progress, memory, paper, storage, status, dashboard) 0.6 s in one
  process vs ~15 Node launches each re-parsing every log. The network retrains hourly and only when a new settled market exists (fixed seed →
  same data gives the same model). Undo: `git revert` of the v2 step-1 commit.
- 2026-11-12 (**derived files left main**). `scorecard.json`, `status.json`, `progress.json`, `dashboard.json`, `backtest-scorecard.json`,
  model/paper/memory caches are no longer committed (they were rewritten every 5 minutes: ~0.8 MB of churn per commit). They are built into
  `site/` and force-pushed as ONE commit to the `site` branch (GitHub Pages); local caches live in `state/`. `main` = code + append-only logs,
  pushed every 15 minutes. Undo: remove `site/`, `state/` from `.gitignore`.
- 2026-11-12 (**removed, unscored or dead**): `scan.mjs`, `agents.mjs`, `index.html`, `bets.json`, `history.json` (Gemini / Agent Flow feed:
  never scored against outcomes); `live.sh`, `live.yml`, skill `kalshi-live-agent` (the hourly Claude dev agent that restarted the pipeline;
  replaced by the supervisor `start.sh` / `start.cmd`); `focus.mjs` (replaced by the live daemon's own prices); `longshot` and `memory` predictor
  code. All still in git history. The `GEMINI_API_KEY` repo secret is no longer read and can be deleted by the owner.
- 2026-11-12 (**live daemon**). `live/daemon.mjs` replaces the minute-polling streamer: authenticated Kalshi WebSocket (`orderbook_delta`,
  `trade`, `ticker`, `market_lifecycle_v2`), sequence-gap check → `get_snapshot`, reconnect with backoff (1 s → 60 s), silent-socket
  watchdog (30 s), REST prices every 30 s whenever the stream is down or there is no key. Settlements arrive on the lifecycle channel
  (REST lookup every 5 min as the fallback). Engine (`live/engine.mjs`) is pure and clocked from outside, so `live/replay.mjs` reproduces
  its output exactly (test fixture built from public data; a real `RECORD_RAW=1` recording can replace it). Verified in the cloud: tests
  with a fake socket (forced disconnect recovers; SSE delivers a price change in < 1 s), and a 3-minute real run in REST mode.
  **Not verified here**: the real authenticated stream — the key exists only on the owner's computer. Undo: `git revert`; `stream.mjs` history.
- 2026-11-12 (**kalshi-auth.mjs allowlist**): added the read-only channels `market_lifecycle_v2` (settlements) and `cfbenchmarks_value`
  (index values; Kalshi's own feed of the crypto settlement reference). Still GET-only, still no order code; the tests assert the client
  can only ever send `subscribe` / `update_subscription`.
- 2026-11-12 (**anomaly guard may switch a predictor OFF by itself**): Brier worse than the market by > 0.10 over ≥ 20 resolved (the weather
  bug's signature) → `data/overrides.json` + a row in `data/decisions.jsonl` + an alert. It can only turn things off. Undo: delete the entry.
- 2026-11-12 (**config v11: `calib` and `ensemble` go live as scored challengers; no edge claimed**). `calib` = logistic correction of the
  market price, refit on every settlement (43 ms). Its L2 penalty was chosen by walk-forward on markets settled before the freeze
  (`config.evals.frozenAt`); 5 values tried (5, 20, 50, 200, 1000) and **all were slightly worse than the market** (+0.0016 … +0.0007 Brier
  over 2,522 unseen markets, 1,743 events). 200 kept. The ensemble (calib + nn + crypto_fair + market) was +0.0016 worse (0.0003…0.0028):
  blending models that carry no edge adds noise. Expectation stated before live data: these will not beat the market until the daemon's
  microstructure inputs (microprice, flow, minute snapshots) exist; the referee decides. Undo: `predictors.calib.on = false`.
- 2026-11-12 (**verdicts are now peeking-safe**). `evals/seq.mjs`: an empirical-Bernstein confidence sequence on per-event Brier differences.
  Simulated under "no difference" and checked after every result: an ordinary 95% interval gave a false "edge" in 46–49% of runs; the
  sequence in 0.3–0.5%. Price of honesty: it is slower. With values that can be anywhere in ±1, a 0.01 Brier edge needs ~1,400 events;
  capping a model's distance from the market at ±0.10 bounds the difference at ±0.20 and brings that to ~400 events. So `calib` and
  `ensemble` are capped at ±0.10 (also a risk limit). alpha 0.05 is split across every predictor and variant ever tried (13 today).
  The old fixed-n interval stays on the dashboard, labelled "snapshot, not peeking-safe".
- 2026-11-12 (**the referee acts**): FAILURE_WORSE on the sequence → the daemon switches the model off (`data/overrides.json`, decision row,
  alert). SUCCESS → alert + it keeps its paper portfolio. `progress.mjs` no longer only "recommends". Real money is still the owner's call.
- 2026-11-12 (**leakage eval**, `evals/leakage.mjs`): 7 automated checks (prediction before resolution; outside data not newer than the row;
  backtest/minute snapshots before resolution; walk-forward training rows known before the test block; retrieved memory and news facts dated
  before the estimate). Today: 0 violations over 1,473 predictions, 236 outside-data stamps, 1,928 backtest rows. Rows now carry `loggedAt`.
