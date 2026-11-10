# Kalshi feed + Agent Flow

**Read-only. Never trades. No account, no keys.**

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
