#!/usr/bin/env bash
# Start the live daemon and keep it running (Mac/Linux). Ctrl+C twice to stop.
#   ./start.sh            run in this terminal
# Auto-restarts with a growing pause (5 s → 60 s) if the daemon exits; pulls new code before each start.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Node.js 22+ is required: https://nodejs.org"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0] >= 22 ? 1 : 0')" = "1" ] || { echo "Node.js 22 or newer is required (you have $(node -v))"; exit 1; }
mkdir -p local
wait_s=5
# Keep the computer awake while this runs, where the OS offers it.
if command -v caffeinate >/dev/null; then KEEP="caffeinate -is"; elif command -v systemd-inhibit >/dev/null; then KEEP="systemd-inhibit --what=idle:sleep --why=kalshi-feed"; else KEEP=""; fi
while true; do
  [ "${NO_PUSH:-0}" = "1" ] || git pull --rebase -q origin "$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null || echo "(could not pull; continuing with the code on disk)"
  started=$(date +%s)
  $KEEP node live/daemon.mjs 2>&1 | tee -a local/daemon.log
  code=${PIPESTATUS[0]}
  [ "$code" = "0" ] && { echo "daemon stopped cleanly"; exit 0; }
  [ $(( $(date +%s) - started )) -gt 300 ] && wait_s=5                      # it ran fine for a while: reset the pause
  echo "$(date -u +%FT%TZ) daemon exited ($code); restarting in ${wait_s}s" | tee -a local/daemon.log
  sleep "$wait_s"; wait_s=$(( wait_s * 2 > 60 ? 60 : wait_s * 2 ))
done
