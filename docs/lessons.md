# Lessons

What we changed because the data (or a mistake) taught us something. Newest first.

- 2026-11-10: The dashboard hid a render error behind "couldn't load data" (one try/catch around fetch and render). Fetch and render errors are now separate and shown.
- 2026-11-10: A predictor that can't act yet (memory with no history) scored "no measurable difference", which reads like a finding. Added verdict "same as market (not active yet)".
- 2026-11-10: Backtest picked both sides of two-way games; they're near-duplicates. Now one market per event in the backtest.

- 2026-11-10: An unquoted skill description containing ": " broke its YAML front matter; caught by the parse check. Always quote descriptions.

- 2026-11-10: Ranking only by volume filled 75 of 80 slots with sports. Now round-robin across categories.
- 2026-11-10: Without a ticker and an append-only log, picks can never be scored. Log first, analyze later.
