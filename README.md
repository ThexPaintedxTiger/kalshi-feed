# Kalshi feed + Agent Flow

**Read-only. Never trades. No account, no keys.**

## Run it 24/7 on your computer
Needs [Node.js 20+](https://nodejs.org) and git, signed in to GitHub with push access to this repo.
```
git clone https://github.com/ThexPaintedxTiger/kalshi-feed
cd kalshi-feed
node stream.mjs
```
Every minute: live prices for watched markets, new outcomes, and an immediate network retrain when outcomes arrive. Full scan every
10 minutes; pushes every 5. Ctrl+C stops it; the cloud schedule takes over when it isn't running. Keep the computer from sleeping
(power settings). Minute-by-minute prices stay on your computer in `local/ticks/` (not pushed).

## Live dashboard
https://thexpaintedxtiger.github.io/kalshi-feed/dashboard.html (refreshes every 5 minutes; header shows how fresh the data is).

## Research agent (v1: measurement loop)
Every 10 minutes it logs predictions for Kalshi markets resolving within 6 hours (`predict.mjs`), checks official results
(`resolve.mjs`) and scores each predictor against the market price (`score.mjs` → `scorecard.json`).
Simulation only. Settings: `config.json`. How it works: `docs/architecture.md`. Findings: `docs/findings.md`.

## Dashboard feed

- `scan.mjs` — every 15 minutes a free GitHub Action reads Kalshi's public market data, keeps the most liquid markets
  (closing within 120 days) and possible profit sets, remembers 48h of prices (`history.json`) to add 1h/24h price moves
  and trading activity, and writes a small `bets.json`.
- `index.html` — Agent Flow with the **Kalshi Neural Forecaster** workflow:
  `📈 Kalshi Data (free) → 📉 Momentum · 📚 Base-Rate · 💧 Liquidity & Rules analysts → 🧠 Ensemble Forecaster → 🛡️ Risk Checker`.
  Open the dashboard for bet cards with win %, data and an "Open in Kalshi" link.

- `agents.mjs` — once an hour, 3 free Gemini agents (momentum, base-rate, rules) rate the top 15 liquid markets in parallel;
  code combines them (confidence-weighted), finds the edge and side, filters risk, and adds `picks` to `bets.json`.
  Needs a free Gemini key saved as the repo secret `GEMINI_API_KEY`. Costs no Claude usage.

Feed: https://raw.githubusercontent.com/ThexPaintedxTiger/kalshi-feed/main/bets.json

Prices move fast and forecasts are estimates, not promises. Check the price and rules in Kalshi before betting.
