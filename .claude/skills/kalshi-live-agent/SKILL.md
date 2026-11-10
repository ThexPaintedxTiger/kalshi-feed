---
name: kalshi-live-agent
description: "The hourly dev agent for the Kalshi research agent: keeps live mode running (starts the next hour of 10-minute pipeline cycles), checks every pipeline hand-off, fixes clear breakage safely, and writes a short plain-English briefing. Use when a scheduled task or the dashboard's 'Run dev agent now' button asks for the live check, or the owner asks to run the dev agent. Not for one-off local runs (use kalshi-run-cycle), deep diagnosis (use kalshi-ops-status) or strategy changes (owner approves)."
---

# Hourly live check (keep it short: a few tool calls when all is well)

Settings: `config.json → live` (artifact URL, trigger id). Never trade, never touch keys, never change strategy settings,
never force-push, never edit logged predictions/outcomes. Escalate per `kalshi-ops-status → Get a human`.

1. **Sync:** `git checkout -q main && git pull -q origin main`.
2. **Keep live mode running:**
   `gh run list --workflow live.yml --limit 5 --json status,createdAt --jq '.[]|[.status,.createdAt]|@tsv'`.
   If no run is `in_progress` or `queued`: `gh workflow run live.yml --ref main -f cycles=6` (≈ 1 hour of 10-minute cycles; free on GitHub).
3. **Check:** read `status.json` (written by the watchdog each cycle). If any check fails other than "Runs on schedule"
   while live mode is running, run `.claude/skills/kalshi-ops-status/status.sh` and follow that skill's table.
   Fix only clear code breakage, on a branch: test (`node test.mjs`), `gh workflow run feed.yml --ref <branch>`, wait for success,
   fast-forward `main`. Anything else goes in the briefing's `needs`.
4. **Dashboard:** don't republish the claude.ai artifact on scheduled runs (publishing needs the owner's approval and would stall an
   unattended run). The live page on GitHub Pages refreshes itself from the data the pipeline pushes. Republish the artifact only when
   the owner asks in a conversation (then: read it, publish `dashboard.html` minus its first line to `config.json → live.artifactUrl`
   with `files: {"dashboard.json": "dashboard.json"}`).
5. **Brief the owner:** append ONE line to `data/briefing.jsonl`:
   `{"ts": "<now ISO>", "checks": "<passed>/<total>", "summary": "2–3 plain sentences: what changed since the last briefing (resolved count, statuses, network verdict), anything wrong", "actions": ["what you did"], "needs": ["only decisions/settings the owner must do"]}`.
   Then `git add data/briefing.jsonl && git commit -m "Dev agent briefing" && git pull --rebase -q && git push -q` (data-only, straight to main).
6. Reply with the same 2–3 sentences. Don't re-explain the project.
