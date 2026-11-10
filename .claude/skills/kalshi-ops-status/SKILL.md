---
name: kalshi-ops-status
description: "Check whether the Kalshi agent's machinery is working: recent GitHub Actions runs and deploys (merges to main), whether the 10-minute schedule fires, data freshness, failed steps and their logs, then diagnose and decide whether a human is needed. Use when asked to look at errors, check the status of the recent deploy or runs, why data stopped updating, or before/after merging a change. Not for judging prediction quality (use kalshi-check-progress) or running the pipeline now (use kalshi-run-cycle)."
---

# Ops status: errors, deploys, and when to get a human

Read-only first. Free (GitHub API via `gh`, no AI calls).

## 1. Look
```bash
git pull -q origin main
.claude/skills/kalshi-ops-status/status.sh
```
It prints: workflow state, last 10 runs, whether any scheduled run exists, latest commit on main, minutes since the last
pipeline run, failing health checks, logs of the latest failed run, and HTTP errors inside steps that are allowed to fail.
A "deploy" here = a push/merge to `main` (the workflow runs from main) and, for the dashboard, an Artifact republish.

## 2. Diagnose (fix only what is clearly in the code)
| Symptom | Likely cause | Action |
|---|---|---|
| Test step failed | Code or math change broke a check | Read the assertion, fix the code (never weaken the test to pass), rerun `node test.mjs` |
| `Kalshi HTTP 429` / slow | Rate limit | Already backs off; if it repeats every run, add `sleep` between pages in `predict.mjs` |
| `Kalshi HTTP 4xx` on every call | API changed or blocked | Check https://trading-api.readme.io/; compare fields with `docs/findings.md` |
| Push rejected in "Save results" | Two runs raced | `concurrency` + `pull --rebase` handle it; if repeated, check for a non-fast-forward cause |
| Gemini 429/503 | Free-tier quota or overload | Expected sometimes; step is allowed to fail. Pin a working model if it fails for 24 h |
| No scheduled runs, manual runs fine | GitHub hasn't activated the cron | Push any commit to main; if still none after ~1 h → human |
| Data >30 min old, no failures | Runs not happening | Same as above |
| `leakage` > 0 | A prediction was logged after resolution | Stop; investigate `score.mjs`/`predict.mjs`. Never edit logged rows |

After a fix: run `kalshi-run-cycle` locally, push to a branch, `gh workflow run feed.yml --ref <branch>`, wait for success,
then fast-forward `main`. Report what failed, the cause, the fix and the evidence.

## 3. Get a human (stop and ask the owner) when
- It needs a **setting or permission only the owner has**: Actions disabled, schedule still not firing after a push and ~1 h,
  GitHub Pages, branch protection, repo secrets (`GEMINI_API_KEY` missing/invalid), a denied tool or permission prompt.
- It touches **money, accounts or keys**: any Kalshi login/API key, trading, payments, or a paid plan/cost increase.
- **Data integrity** is at risk: leakage > 0, outcomes that disagree with Kalshi, anything that would rewrite history
  (force-push, editing JSONL). Never do these to "fix" an error.
- The **same failure repeats 3 runs in a row after one fix attempt**, or the cause is outside the repo (Kalshi/GitHub outage, API terms change).
- A fix would **change strategy** (thresholds, predictors, goals): that is a proposal, not a fix.

When escalating, give: what's broken, since when, evidence (run id + log lines), what you tried, and the one decision you need.
