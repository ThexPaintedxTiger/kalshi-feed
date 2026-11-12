---
name: kalshi-ops-status
description: "Check whether the machinery is working: daemon heartbeat and stream state, the cloud fallback's recent runs, data freshness, failed steps, the published site, storage, LLM spend. Use when asked to look at errors, why data stopped updating, or before/after merging a change. Not for judging prediction quality (kalshi-check-progress)."
---

# Ops status

1. Heartbeat: `git fetch origin site && git show origin/site:heartbeat.json` → `at` (age), `mode` (`ws` = stream live, `rest` = fallback),
   `ws.reconnects`, `ws.gaps`, `staleTotalSec`. Older than ~3 min = the daemon is not running on the owner's computer.
2. Watchdog: `git show origin/site:status.json` → `checks` (each has `ok` and `detail`) and `needs`.
3. Logs moving? `git log origin/main --since="2 hours ago" --oneline -- data | head` (the daemon pushes every 15 min; the cloud fallback
   every 10 min only while the heartbeat is stale). Scans: last rows of `data/runs.jsonl`.
4. Cloud fallback: `gh run list --workflow feed.yml --limit 10` (it prints "skipping" while the daemon is alive).
5. Site: `curl -sI https://thexpaintedxtiger.github.io/kalshi-feed/` must be 200 (Pages: Settings → Pages → branch `site`, folder `/`).
6. On the owner's computer: `local/daemon.log`, `state/perf.jsonl`, `node llm.mjs`, `node kalshi-auth.mjs`, `node live/alerts.mjs "test" "hello"`.
7. Get a human when: the key stopped working, the computer is off, Pages is disabled, or the disk is nearly full.
