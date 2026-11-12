---
name: kalshi-add-predictor
description: "Add a new predictor (a hypothesis about Kalshi markets) so it is logged, scored on its own by the referee and shown on the dashboard. Use when testing a new idea, model or signal. Not for outside data sources (kalshi-outside-data)."
---

# Add a predictor

1. State the hypothesis in one sentence and what would falsify it.
2. Code: add `PRED.<name> = (c, ctx) => P(YES) or null` in `predictors.mjs`. It may use only what was known at `c.at`.
   A trained model lives in `models/<name>.mjs` with a walk-forward function (see `models/calib.mjs`): training rows must have
   `known < ` the test block's start.
3. `config.json`: `predictors.<name> = { on: true, hypothesis }`, `models.<name>.variantsTried` (count every setting you tried —
   the referee splits alpha across them), bump `version`. If the model can be capped near the market, set `models.<name>.maxDev`:
   the peeking-safe test is then much sharper.
4. Tests in `tests/`: the math, a planted-signal check, and a no-look-ahead check.
5. Choose settings only on data settled before `config.evals.frozenAt`; never tune on the live record.
6. `node test.mjs && node cycle.mjs`; add a dated entry to `docs/lessons.md` and a row to `data/decisions.jsonl` (what, why, evidence, undo).
7. No paper portfolio until it passes; no claim until the referee says SUCCESS.
