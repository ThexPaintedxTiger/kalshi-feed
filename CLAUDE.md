# Kalshi feed + Agent Flow: handoff for Claude Code

## Rules (always)
- **Read-only. Never trade, never place bets, never handle Kalshi account keys.** Only public market data.
- Never put API keys in code or chat. The Gemini key lives only in the repo secret `GEMINI_API_KEY`.
- The owner wants the **least usage possible**. Prefer code over AI calls, and say what a change costs. Give a cheaper alternative when there is one.
- Picks are estimates. Keep the stake caps (≤2% of bankroll per pick).

## What this is
A free pipeline that finds Kalshi bets and shows them in a dashboard.

```
GitHub Action (every 15 min, .github/workflows/feed.yml)
  scan.mjs   → reads ALL open Kalshi events (public API, paginated, ~19k events)
               keeps liquid markets (≤120 days, vol ≥50), top 400 by activity
               profit-set scan (mutually exclusive events, cost ≥ $0.90 after fees)
               history.json = 48h price memory → chg1h, chg24h, volGrowth
               writes bets.json (top 150 markets + sets; keeps old picks)
  agents.mjs → at most hourly, FREE Gemini (secret GEMINI_API_KEY)
               ONE request = 3 analysts (momentum, baseRate, rules) on the top 15 liquid markets
               code (not AI): confidence-weighted ensemble → edge, YES/NO side, risk filter (edge ≥5 pts), stake
               writes picks/picksUpdated/picksAgents into bets.json
  commit bets.json + history.json
```

- Feed URL: https://raw.githubusercontent.com/ThexPaintedxTiger/kalshi-feed/main/bets.json
- Kalshi API: https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true&limit=200 (cursor pagination)
- Market links: `https://kalshi.com/markets/<series_ticker lowercase>` (verified, redirects to the market)
- Fee estimate: `ceil(0.07 × P × (1−P))` per contract, in cents

## Agent Flow (the UI)
- `index.html` here = public copy with only the **Kalshi Neural Forecaster** workflow.
- The owner's main copy is a claude.ai artifact: https://claude.ai/artifact/HLrAvS3ABiJHXuQUUa5RRt (Claude engine works only there).
- Single-file app: canvas of agents, ⚙ AI engine picker (Claude in claude.ai; Gemini/Groq/OpenRouter/Ollama elsewhere),
  📊 Dashboard (KPIs, run history, per-agent stats, 🎯 bet cards with win %, edge, Data, "Open in Kalshi"), 🧠 3D brain view,
  🧮 Calculator node (`calc` blocks), 📈 Kalshi Data node (`kdata`: loads feed → falls back to saved bets).
- Workflow: Start → 📈 Kalshi Data → (📉 Momentum · 📚 Base-Rate · 💧 Liquidity & Rules, run in parallel) → 🧠 Ensemble → 🛡️ Risk Checker.
- Inside claude.ai, pages **cannot fetch** outside data. The user refreshes with 🔄 Live data → copy feed → Ctrl+V on the page (auto-runs).
  The Chrome/file copy fetches the feed automatically.

## Known issues: investigate when the owner says "go"
1. **AI step errors and slowness.** Run #2 (6m43s) and #3 (8m35s, cancelled) failed:
   Gemini 429 "exceeded your current quota" on `gemini-omni-*`, 503 "high demand" on `gemini-flash-latest` / `gemini-3.8-flash`, plus a `fetch failed`.
   Run #4 worked in ~2 min with `gemini-flash-lite-latest` (lite models first now; no-quota models skipped).
   To do: measure scan time vs AI time per step (`gh api .../actions/jobs/<id>/logs`), cut retry waits, fail fast when Gemini is down,
   and consider caching ListModels or pinning a working model.
2. **Schedule not firing yet.** As of 06:43 CT Nov 10, only manual (workflow_dispatch) runs exist. Check whether `schedule` runs appear. If not, re-save the workflow or check that Actions is enabled.
3. **Scan size.** 100 pages × 200 events ≈ 19k events per run; most aren't liquid. Consider filters (e.g. `min_close_ts`/`max_close_ts`, series filters) to cut time.
4. **0 picks on the last run.** Expected when markets are fairly priced (edge filter ≥5 pts). Optional: also publish a "watchlist" of all rated markets so the dashboard isn't empty.

## Ideas queued (ask the owner first)
- Track pick outcomes (settled markets) to score the agents and tune the confidence weights (real feedback loop).
- GitHub Pages for a public Agent Flow URL with auto-loading data (repo setting change: needs owner approval).
