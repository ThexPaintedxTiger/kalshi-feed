#!/usr/bin/env bash
# One full pipeline cycle (used by the 10-minute workflow and by live mode).
# Required steps stop the cycle if they fail; optional steps log a warning and continue.
# SKIP_SAVE=1 runs everything without committing (local testing).
set -u
step() { local name="$1"; shift; echo "::group::$name"; "$@"; local rc=$?; echo "::endgroup::"; return $rc; }
need() { step "$@" || { echo "::error::$1 failed"; exit 1; }; }
want() { step "$@" || echo "::warning::$1 failed (continuing)"; }

need "Tests" node test.mjs
need "Check outcomes" node resolve.mjs
need "Memory" node memory.mjs
need "Research: log predictions" node predict.mjs
want "Backtest agent (hourly)" timeout 300 node backtest.mjs
want "Train neural network (hourly)" timeout 300 node nn.mjs
need "Scorecard" node score.mjs
need "Progress vs goals" node progress.mjs
need "Paper portfolios" node paper.mjs
want "Agent Flow feed (every 25 min)" node scan.mjs
want "Gemini picks (hourly)" timeout 360 node agents.mjs
want "Focus markets (live prices)" node focus.mjs
need "Watchdog" node status.mjs
need "Dashboard data" node dashboard.mjs

[ "${SKIP_SAVE:-0}" = "1" ] && { echo "SKIP_SAVE=1: not committing"; exit 0; }
git config user.name "kalshi-feed-bot"
git config user.email "actions@users.noreply.github.com"
git config merge.keep.driver true   # used by .gitattributes: keep the already-pushed derived file on a clash
git add bets.json history.json data scorecard.json backtest-scorecard.json progress.json status.json dashboard.json
git commit -q -m "Update Kalshi feed" || { echo "nothing to commit"; exit 0; }
for i in 1 2 3; do git pull --rebase -q && git push -q && { echo "saved"; exit 0; }; sleep 5; done
echo "::error::could not push results"; exit 1
