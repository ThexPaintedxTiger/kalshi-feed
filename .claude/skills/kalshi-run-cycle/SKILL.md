---
name: kalshi-run-cycle
description: "Run one Kalshi research cycle on this machine right now (tests, log predictions, check outcomes, score, progress) and report counts and errors. Use when asked to run, refresh or test the prediction agent/pipeline now, or after changing predict/resolve/score code. Not for repeating on a schedule (the GitHub Action does that every 10 min; to trigger it in the cloud use gh workflow run) and not for judging results (use kalshi-check-progress)."
---

# Run one research cycle

Runs the same steps as the GitHub Action, on this machine. Free: public Kalshi data, no AI calls, no keys.

```bash
node test.mjs && node predict.mjs && node resolve.mjs && node score.mjs && node progress.mjs
```

Report in a few lines: tests passed?, markets scanned, candidates, new predictions logged, newly resolved,
and the `progress.mjs` summary line. On failure, show the failing step's output; don't retry blindly.

Notes
- Local runs are real predictions (`run: "local"`) and append to the same files as the Action. Commit them, or
  `git checkout -- data scorecard.json progress.json` to discard if this was only a test.
- Kalshi rate-limits bursts (HTTP 429); `lib.mjs → kalshi()` backs off. Don't loop this skill faster than every few minutes.
- The scheduled run lives in `.github/workflows/feed.yml`; to run it in the cloud instead: `gh workflow run feed.yml`.
