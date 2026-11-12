# kalshi-feed

A read-only research system for short-duration [Kalshi](https://kalshi.com) markets. It logs a prediction for each market before
it resolves, collects the official outcome, and judges every model against the market price with tests that stay honest even when
you check the dashboard all day. **It never trades.**

**Status (2026-11-12): nothing beats the market.** The dashboard says so, and says what evidence is missing.

- Dashboard: https://thexpaintedxtiger.github.io/kalshi-feed/ (published data, ≤ 2 minutes old while the daemon runs)
- At home: http://localhost:8787 (live, sub-second)

## Run it (owner's computer, Node 22+)
```bash
./start.sh
```
Windows: double-click `start.cmd`. Details, the read-only key, alerts, the local model and running it as a service: `docs/manual.md`.

## Try it anywhere (public data, no keys)
```bash
node test.mjs
```
```bash
NO_PUSH=1 node cycle.mjs
```

## Read more
`CLAUDE.md` (rules and layout) · `docs/architecture.md` · `docs/manual.md` · `docs/lessons.md` · `docs/findings.md` · `docs/handoff.md`
