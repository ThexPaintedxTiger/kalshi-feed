# Lessons

What we changed because the data (or a mistake) taught us something. Newest first.

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
