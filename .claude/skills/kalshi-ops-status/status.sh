#!/usr/bin/env bash
# Read-only status report: workflow state, recent runs, schedule, data freshness, health, last failure.
# Needs: gh (authenticated for the repo), node. Run from the repo root.
set -u
R=ThexPaintedxTiger/kalshi-feed
echo "== Workflow"; gh api repos/$R/actions/workflows --jq '.workflows[]|"\(.name): \(.state)"' 2>&1 | head -3
echo "== Last 10 runs (newest first)"
gh run list -R $R --workflow feed.yml --limit 10 --json databaseId,event,headBranch,status,conclusion,createdAt \
  --jq '.[]|"\(.createdAt)  \(.event)  \(.headBranch)  \(.status)/\(.conclusion // "-")  id \(.databaseId)"' 2>&1
echo "== Schedule"
last=$(gh run list -R $R --workflow feed.yml --event schedule --limit 1 --json createdAt --jq '.[0].createdAt // ""' 2>/dev/null)
if [ -z "$last" ]; then echo "NO scheduled run ever recorded"; else echo "last scheduled run: $last"; fi
echo "== Latest commit on main"; gh api repos/$R/commits/main --jq '"\(.commit.author.date)  \(.commit.message|split("\n")[0])"' 2>&1
echo "== Data freshness and health (local checkout; git pull first)"
node -e '
const fs=require("fs"),rd=f=>{try{return fs.readFileSync(f,"utf8")}catch{return ""}};
const runs=rd("data/runs.jsonl").trim().split("\n").filter(Boolean).map(JSON.parse), last=runs[runs.length-1];
if(last) console.log(`last pipeline run ${last.ts} (${Math.round((Date.now()-Date.parse(last.ts))/6e4)} min ago), logged ${last.logged}`);
const p=JSON.parse(rd("progress.json")||"{}");
console.log(`goal ${p.goal}; health ${p.health?.ok?"OK":"PROBLEM"}`);
for(const [k,c] of Object.entries(p.health?.checks||{})) if(!c.ok) console.log(`  failing: ${k} = ${c.value} (target ${c.max?"<=":">="} ${c.target})`);'
fail=$(gh run list -R $R --workflow feed.yml --limit 20 --json databaseId,conclusion --jq '[.[]|select(.conclusion=="failure")][0].databaseId // ""' 2>/dev/null)
if [ -n "$fail" ]; then echo "== Most recent failed run $fail (failed steps, last 40 lines)"; gh run view $fail -R $R --log-failed 2>&1 | tail -40; else echo "== No failed runs in the last 20"; fi
# Steps that passed but logged problems (continue-on-error steps):
latest=$(gh run list -R $R --workflow feed.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
[ -n "$latest" ] && { echo "== Warnings in latest run $latest"; gh run view $latest -R $R --log 2>/dev/null | grep -E "HTTP [45][0-9][0-9]|failed|Error|error:" | grep -v "^.*##\[group\]" | cut -c1-220 | tail -10; }
exit 0
