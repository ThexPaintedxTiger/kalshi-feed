#!/usr/bin/env bash
# Live mode: run the pipeline every 10 minutes, N times (default 6 ≈ 1 hour), inside one GitHub Actions job.
# Started by the hourly dev agent (or by hand), so the feed stays live even when GitHub's cron doesn't fire.
set -u
N="${1:-6}"
for i in $(seq 1 "$N"); do
  start=$(date +%s)
  echo "=== live cycle $i/$N at $(date -u +%H:%M:%S) UTC ==="
  bash cycle.sh || echo "::warning::cycle $i failed; trying again next cycle"
  [ "$i" -lt "$N" ] || break
  wait=$(( start + 600 - $(date +%s) ))
  [ "$wait" -gt 0 ] && sleep "$wait"
done
