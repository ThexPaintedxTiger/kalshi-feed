---
name: kalshi-run-cycle
description: "Run one Kalshi research cycle on this machine right now (tests, outcomes, models, new predictions, backtest, evals, dashboard data) and report counts and errors. Use when asked to run, refresh or test the pipeline now, or after changing pipeline code. Not for the 24/7 run (that is the live daemon, start.sh) and not for judging results (use kalshi-check-progress)."
---

# Run one research cycle

One process, public Kalshi data, no keys. Logs load once (`core/store.mjs`); every step shares them.

```bash
node test.mjs && node cycle.mjs
```

- `FORCE=1 node cycle.mjs` also forces the hourly parts (backtest, full walk-forward).
- It appends real rows to `data/` (predictions, outcomes). If this was only a test, discard them: `git checkout -- data`.
  Never run it on the owner's computer while the daemon is running (two writers would log the same markets twice).
- Derived files land in `site/` and `state/` (git-ignored). `node publish.mjs all "why"` pushes logs to `main` and the
  site to the `site` branch; `NO_PUSH=1` turns pushing off.
- Report: the `predict`, `models`, `maker` lines, the cycle time, and any `failed:` step. Timings: `state/perf.jsonl`.
