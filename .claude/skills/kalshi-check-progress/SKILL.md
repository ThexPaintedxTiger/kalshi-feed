---
name: kalshi-check-progress
description: "Read-only check of whether the Kalshi research system is moving toward its goal: the referee's peeking-safe verdict per model, picks after fees vs controls, leakage eval, pipeline health, and what evidence is still missing. Use when asked how it is doing, whether anything beats the market, about the scorecard or evals, or for a scheduled follow-up. Not for producing predictions (kalshi-run-cycle)."
---

# Check progress

1. `git pull`, then rebuild the derived files without touching the network:
   `node --input-type=module -e 'import {makeCtx} from "./core/ctx.mjs"; import {derive} from "./cycle.mjs"; const c=makeCtx(); c.quiet=true; await derive(c); console.log(c.out.evals.headline)'`
2. Read `site/evals.json`: `headline`, each `models.<name>.status`, `vsMarket.sequence` (the peeking-safe range; **this** is the verdict),
   `money`, `why`, and `leakage.total` (must be 0). `site/status.json` has the plain-English answer and the watchdog checks.
3. Rules for reading it:
   - SUCCESS needs the whole sequence range below 0 on ≥ 100 live markets **and** picks' P&L range above 0 on ≥ 100 picks.
   - `snapshot95` is an ordinary interval: descriptive only. Never call an edge from it (checking it repeatedly finds false edges ~half the time).
   - Development evidence (`cards.<name>.development`, walk-forward on past markets) supports, never decides.
   - If nothing beats the market, say so. That is a valid, expected result.
4. The agent acts on verdicts itself (see `docs/lessons.md`, `data/decisions.jsonl`). Real money is the only thing that needs the owner.
