---
name: kalshi-check-progress
description: "Read-only check of whether the Kalshi prediction agent is moving toward its goal: pulls the latest data, runs progress.mjs and explains goal status, pipeline health and each predictor's status vs the market, with recommendations to approve. Use when asked how the agent is doing, whether it is improving or working, about the scorecard, success/failure, or for a scheduled follow-up check. Not for producing new predictions (use kalshi-run-cycle) or changing the strategy (proposals only; owner approves)."
---

# Check progress against the goals

Read-only review of whether the agent is moving toward its goal. Success/failure are defined in `CLAUDE.md → Goals`
and `config.json → goals`.

1. `git pull -q origin main` (the Action commits new data every ~10 min).
2. `node progress.mjs` then read `progress.json`; for detail read `scorecard.json`, for history `data/progress.jsonl`.
3. Report: overall goal status, health (any failing check), and per predictor: status, n resolved, Brier vs market,
   picks, trend, recommendation. Keep market price, our estimate and outcomes separate. Never call something an edge
   unless its status is SUCCESS.
4. If health fails: runs missing → check `gh run list --limit 10`; backlog → run `node resolve.mjs` and inspect; leakage > 0 → stop and investigate `score.mjs`.
5. Recommendations (turn a predictor off, retire a hypothesis, new idea) are proposals: ask the owner before editing
   `config.json`. After approval, record the change and the evidence in `docs/lessons.md` (dated, newest first).
6. Optional, if the owner wants the claude.ai dashboard (https://claude.ai/artifact/YWELuS2iUX9Y62DHMX737v) current: after step 1,
   republish it with the Artifact tool. Use `url` set to that link, the page (`dashboard.html` without its first `<!doctype html>` line), and
   `files: {"dashboard.json": "dashboard.json"}`. The repo copy of `dashboard.html` loads live data from GitHub by itself.

