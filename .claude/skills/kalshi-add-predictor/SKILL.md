---
name: kalshi-add-predictor
description: "Add a new predictor to test a hypothesis about Kalshi markets."
---

# Add a predictor (one hypothesis = one predictor)

A predictor turns data available *before* resolution into P(YES). It is judged only by the scorecard against the market price.

1. State the hypothesis in one sentence and why it might beat the market. Add it to `docs/findings.md → Hypotheses` (marked *hypothesis*).
2. Cost check: prefer code and free data. If it needs an API or AI call, state the cost per run and a cheaper alternative, and get owner approval.
3. `config.json → predictors.<name>`: `{ "on": true, ...params, "hypothesis": "..." }`. Bump `config.version` (rows record `cfg`).
4. `predict.mjs → PRED.<name> = c => probability` using only `c.m` (raw market), `c.ask`, `c.bid`, `c.mid` or data fetched in this run.
   Never use anything published after the row's `ts` (no future information). Return a number in [0, 1].
5. Add a test in `test.mjs` for the predictor's math; run `node test.mjs`.
6. Run one cycle (skill `kalshi-run-cycle`) and confirm rows contain `est.<name>`.
7. Document it in `docs/architecture.md` (predictor list). Judge it later with `kalshi-check-progress`, not on a few results.
