#!/usr/bin/env bash
# One full pipeline cycle (cloud fallback, every 10 minutes from feed.yml; also fine by hand).
# Steps run in one Node process (cycle.mjs). SKIP_SAVE=1 runs everything without committing or pushing.
set -u
# Step aside while the owner's live daemon is running: it does every step itself (its heartbeat on the site branch is < 15 min old).
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ "${FORCE:-0}" != "1" ] && node publish.mjs heartbeat-fresh; then
  echo "live daemon is active on the owner's computer — skipping this cloud cycle"; exit 0
fi
node test.mjs || { echo "::error::tests failed"; exit 1; }
node cycle.mjs || { echo "::error::cycle failed"; exit 1; }
[ "${SKIP_SAVE:-0}" = "1" ] && { echo "SKIP_SAVE=1: not committing"; exit 0; }
node publish.mjs all "cloud cycle"
