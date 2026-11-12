---
name: kalshi-history
description: "Use the system's history: backtest on past settled markets, what memory knows about a series, similar past markets (RAG), replaying a recorded stream day, the owner's own trades from a CSV or read-only key, and the read-only MCP tools. Use for questions about past markets, a series, or 'how did markets like this resolve'. Not for live predictions or verdicts."
---

# History and memory

- Backtest: runs hourly inside the cycle (`backtest.mjs`, ≤ 300 candle calls); rows in `data/backtest/`, scorecard in `site/backtest-scorecard.json`.
  Supporting evidence only. `FORCE=1 node cycle.mjs` runs it now.
- Similar past markets: `node rag.mjs "Bitcoin above 73000 at 5pm"` (base rate + examples; retrieval is filtered by time).
- Replay a recorded day (owner's computer, daemon started with `RECORD_RAW=1`): `node live/replay.mjs local/raw/YYYY-MM-DD.jsonl.gz`.
- Owner's own trades (private, never committed): `node import-trades.mjs [csv]` or `--api` → `private/my-trades-report.json`.
- MCP (read-only; `npm --prefix mcp install` once): `get_status`, `get_scorecard`, `search_predictions`, `recall_series`, `list_skills`,
  `live_market`, `estimates`, `scorecard`, `search_similar`, `rules`, `eval_report`, `health`. Smoke test: `node mcp/test-client.mjs`.
