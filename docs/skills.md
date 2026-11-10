# Skills

Project skills live in `.claude/skills/<name>/SKILL.md` (YAML front matter: `name`, `description`). Claude loads them
automatically in this repo. New ones follow the `save-as-skill` convention.

## Description review (2026-11-10)
Test applied to each description: (a) it names its trigger situations, (b) it states the action, (c) it marks the boundary
with any skill that could fire on the same request. Only descriptions failing the test were rewritten.

### Repo skills
| Skill | What it does | Should trigger when | Overlaps | Verdict |
|---|---|---|---|---|
| `kalshi-run-cycle` | Runs test → predict → resolve → score → progress locally; reports counts/errors | "run / refresh / test the agent now", after code changes | `run` (generic app launcher; it defers to a project skill), `loop` (repetition), the GitHub Action (scheduled cloud runs), `kalshi-check-progress` (judging results) | **Rewritten**: draft didn't separate local vs scheduled runs or running vs judging |
| `kalshi-check-progress` | Read-only: pull data, run `progress.mjs`, explain goal status, health, predictor status; propose changes | "how is it doing / improving / working", scorecard, success/failure, scheduled follow-ups | `kalshi-run-cycle` (creates data), `loop` (can call it on an interval: they compose, not conflict) | **Rewritten**: draft "check how the agent is doing" was vague and didn't say read-only or proposals-only |
| `kalshi-add-predictor` | Checklist to add one hypothesis as a predictor (config, code, version bump, tests, docs) | "add a predictor" / testing a new hypothesis | None among installed skills | **Kept**: unambiguous. Minor risk: may under-fire on phrasing like "try weather data" |
| `kalshi-ops-status` | Read-only: runs `status.sh` (workflow state, runs, schedule, freshness, failed logs), diagnoses, decides when to get a human | "look at errors", "status of the recent deploy/runs", "why did data stop", before/after a merge | `kalshi-check-progress` (prediction quality, not machinery) and `kalshi-run-cycle` (runs instead of inspecting); health checks appear in both, so the boundary is stated in each description | **Clear** (written with what/when/not-for from the start) |
| `kalshi-history` | Backtest past markets, series memory lookup, import/score the owner's trades, use the MCP server | past markets/bets, backtesting, "what do we know about this series", own trade history, MCP setup | `kalshi-run-cycle` (live run), `kalshi-check-progress` (live record), `kalshi-ops-status` (errors) — boundaries stated in its description | **Clear** (written with what/when/not-for) |
| `kalshi-live-agent` | Hourly dev agent runbook: keep live mode running, check hand-offs, fix clear breakage, refresh dashboard, write briefing | scheduled task / dashboard button / "run the dev agent" | `kalshi-ops-status` (deep diagnosis), `kalshi-run-cycle` (local run) — boundaries stated | **Clear** |
| `save-as-skill` | Project convention for saving a tested script as a skill | a repo script will be reused; "save this as a skill/tool" | `anthropic-skills:skill-creator` (general skill authoring and evals) | **Rewritten**: draft "save a script as a skill" collided with skill-creator |

Before → after (rewritten only):
- `kalshi-run-cycle`: "Run the Kalshi research pipeline locally and report the results." → see SKILL.md (adds now-vs-scheduled and run-vs-judge boundaries).
- `kalshi-check-progress`: "Check how the prediction agent is doing." → see SKILL.md (read-only, trigger phrases, proposals only).
- `save-as-skill`: "Save a script as a skill." → see SKILL.md (scoped to this repo; general work goes to skill-creator).

### Installed skills that overlap (not in this repo; reported, not edited)
| Skill | What it does | Triggers | Overlap with repo skills | Verdict |
|---|---|---|---|---|
| `run` | Launches and drives a project's app to see a change working | "run / start / screenshot the app" | `kalshi-run-cycle`; `run` looks for a project skill first, so they chain | Clear |
| `loop` | Repeats a prompt or slash command on an interval | "every N minutes", "keep checking" | Can wrap `kalshi-check-progress`; in cloud sessions, scheduled follow-ups use send_later instead | Clear |
| `anthropic-skills:skill-creator` | General skill creation and improvement | (listed with **no description** in this session) | `save-as-skill` | **Ambiguous**: no description, so it can't be routed reliably. Suggested: "Create, test and improve skills in general, including evals and packaging. Use for skills outside a project's own conventions." |
| `session-start-hook` | Creates a SessionStart hook committed to a repo | Only when a SessionStart hook is requested | None (listed to rule it out) | Clear |
