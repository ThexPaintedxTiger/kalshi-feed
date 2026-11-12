# Skills

Project skills for Claude live in `.claude/skills/<name>/SKILL.md`.

| Skill | Use it to |
|---|---|
| `kalshi-run-cycle` | Run one full cycle now and report counts and errors. |
| `kalshi-check-progress` | Read the referee's verdicts and say what evidence is missing. |
| `kalshi-add-predictor` | Add a hypothesis as a scored predictor, the honest way. |
| `kalshi-outside-data` | Add or check a data source that is not Kalshi. |
| `kalshi-ops-status` | Check the daemon, the cloud fallback, the site and storage. |
| `kalshi-history` | Backtest, similar past markets, replay, own trades, MCP tools. |
| `save-as-skill` | The convention for saving a tested script as a new skill. |

Removed in v2: `kalshi-live-agent` (the hourly Claude dev agent that restarted the pipeline; replaced by `start.sh` / `start.cmd`).

## MCP server (read-only)
`mcp/server.mjs`, registered in `.mcp.json`. Install once: `npm --prefix mcp install`. Tools: `get_status`, `get_scorecard`,
`search_predictions`, `recall_series`, `list_skills`, `live_market`, `estimates`, `scorecard`, `search_similar`, `rules`,
`eval_report`, `health`. It never writes, never trades and never reads `private/`.
