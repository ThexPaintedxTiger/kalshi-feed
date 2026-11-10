// Offline checks for the math and the leakage guard. Run: node test.mjs
import assert from "node:assert/strict";
import { fee, ev, resolvesAt } from "./lib.mjs";
import { brier, logLoss, pnl, score } from "./score.mjs";

// Fees: Kalshi taker fee rounds up to the cent.
assert.equal(fee(0.5), 0.02);          // 0.07 × .5 × .5 = 1.75¢ → 2¢
assert.equal(fee(0.1), 0.01);          // 0.63¢ → 1¢
assert.equal(fee(0.99), 0.01);
// EV: a fair estimate equal to the mid never shows an edge once spread and fees are paid.
const e = ev(0.5, 0.51, 0.49);
assert.ok(e.yes < 0 && e.no < 0);
assert.equal(Math.round(ev(0.7, 0.5, 0.48).yes * 100), 18); // 0.70 − 0.50 − 0.02
// Resolution time: earlier of close and expected expiration.
assert.equal(resolvesAt({ close_time: "2026-11-24T00:00:00Z", expected_expiration_time: "2026-11-10T20:00:00Z" }), "2026-11-10T20:00:00.000Z");
// Scores.
assert.equal(brier(1, 1), 0); assert.equal(brier(0.5, 0), 0.25);
assert.ok(Math.abs(logLoss(0.5, 1) - Math.log(2)) < 1e-12);
assert.equal(logLoss(0, 1), logLoss(0.01, 1));          // clipped, never infinite
assert.equal(pnl({ side: "yes", cost: 0.4 }, 1), 0.58);  // 1 − 0.40 − 0.02
assert.equal(pnl({ side: "no", cost: 0.4 }, 1), -0.42);

// Leakage guard + verdicts on synthetic data.
const P = (i, ts, est) => ({ ts, ticker: "T" + i, event: "E" + i, cat: "X", resolvesAt: "2026-01-01T12:00:00Z", est, picks: {} });
const preds = [], outs = [];
for (let i = 0; i < 200; i++) {
  const y = i % 2;
  preds.push(P(i, "2026-01-01T10:00:00Z", { market: 0.5, good: y ? 0.8 : 0.2 }));
  outs.push({ ticker: "T" + i, result: y ? "yes" : "no", settledAt: "2026-01-01T12:05:00Z", closedAt: "2026-01-01T12:00:00Z" });
}
preds.push(P(999, "2026-01-01T13:00:00Z", { market: 0.9 }));  // logged AFTER resolution
outs.push({ ticker: "T999", result: "yes", settledAt: "2026-01-01T12:05:00Z", closedAt: "2026-01-01T12:00:00Z" });
const sc = score(preds, outs, { score: { minResolved: 100, calibrationBins: 10 } });
assert.equal(sc.excludedLeakage, 1);
assert.equal(sc.resolved, 200);
assert.equal(sc.predictors.good.verdict, "beats market (Brier)");
assert.equal(sc.predictors.market.brier.mean, 0.25);
const small = score(preds.slice(0, 20), outs, { score: { minResolved: 100, calibrationBins: 10 } });
assert.equal(small.predictors.good.verdict, "insufficient data"); // never conclude from few results
console.log("all tests passed");
