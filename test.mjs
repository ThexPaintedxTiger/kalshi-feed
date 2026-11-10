// Offline checks for the math and the leakage guard. Run: node test.mjs
import assert from "node:assert/strict";
import { fee, ev, resolvesAt, hash, r4 } from "./lib.mjs";
import { brier, logLoss, pnl, score } from "./score.mjs";
import { predictorStatus, health, trend, evaluate } from "./progress.mjs";
import { makeRecall } from "./memory.mjs";
import { PRED, estimate } from "./predictors.mjs";
import { parseCsv, mapColumns, normalize } from "./import-trades.mjs";
import { init, rng, backprop, predict, train, logLoss as nnLoss } from "./nnlib.mjs";
import { orderFee, kellyFraction, simulate, monteCarlo } from "./paper.mjs";

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
assert.equal(score(preds.map(p => ({ ...p, est: { ...p.est, same: p.est.market } })), outs, { score: { minResolved: 100, calibrationBins: 10 } }).predictors.same.verdict, "same as market (not active yet)");
const small = score(preds.slice(0, 20), outs, { score: { minResolved: 100, calibrationBins: 10 } });
assert.equal(small.predictors.good.verdict, "insufficient data"); // never conclude from few results

// Goal statuses (success / failure definitions).
const G = { minResolved: 100, minPicks: 100, retireAfter: 300, minForTrend: 20 };
const pr = (n, mean, lo, hi, pk = 0, plo = null) => ({ n, brierVsMarket: { mean, lo, hi }, picks: { n: pk, pnlPerContract: { mean: plo, lo: plo, hi: plo } } });
assert.equal(predictorStatus(pr(10, -0.1, -0.2, 0), G).status, "INSUFFICIENT");
assert.equal(predictorStatus(pr(50, -0.01, -0.03, 0.01), G).status, "ON_TRACK");
assert.equal(predictorStatus(pr(50, 0.01, -0.01, 0.03), G).status, "OFF_TRACK");
assert.equal(predictorStatus(pr(150, -0.02, -0.03, -0.01, 120, 0.02), G).status, "SUCCESS");
assert.equal(predictorStatus(pr(150, -0.02, -0.03, -0.01, 40, 0.02), G).status, "ACCURATE_NOT_PROFITABLE");
assert.equal(predictorStatus(pr(150, -0.02, -0.03, -0.01, 120, -0.01), G).status, "ACCURATE_NOT_PROFITABLE");
assert.equal(predictorStatus(pr(150, 0.02, 0.01, 0.03), G).status, "FAILURE_WORSE");
assert.equal(predictorStatus(pr(350, -0.001, -0.01, 0.008), G).status, "FAILURE_RETIRE");
// Health: targets scale while warming up; leakage and backlog must be zero.
const H = { minRunsPerDay: 100, minNewPerDay: 50, maxLeakage: 0, maxBacklogHours: 24 }, T = Date.parse("2026-01-03T00:00:00Z");
const runs = Array.from({ length: 140 }, (_, i) => ({ ts: new Date(T - i * 6e5).toISOString() }));
const hp = [{ ts: "2026-01-02T12:00:00Z", ticker: "A", resolvesAt: "2026-01-02T14:00:00Z" }, { ts: "2026-01-01T00:00:00Z", ticker: "B", resolvesAt: "2026-01-01T01:00:00Z" }];
const h1 = health({ excludedLeakage: 0 }, runs, hp, [{ ticker: "A" }], H, T);
assert.equal(h1.checks.runsLast24h.ok, true);
assert.equal(h1.checks.unresolvedBacklog.value, 1);   // B is >24h past resolution with no outcome
assert.equal(h1.ok, false);
assert.equal(health({ excludedLeakage: 0 }, runs.slice(0, 6), [], [], H, T).warmingUp, true);
// Trend.
assert.equal(trend({ n: 50, mean: -0.01, width: 0.02 }, { n: 30, mean: 0.01, width: 0.04 }), "+20 resolved, interval narrowing, direction flipped (0.01 → -0.01)");
assert.equal(evaluate({ predictors: { market: pr(150, 0, 0, 0), x: pr(150, 0.02, 0.01, 0.03) } }, runs, [], [], { edge: G, health: H }, T).goal,
  "ALL_HYPOTHESES_FAILED — add a new predictor");

// Memory never sees the future: recall at time t only uses markets settled before t.
const mem = makeRecall(Array.from({ length: 30 }, (_, i) => ({ series: "S", mid: 0.5, y: i < 20 ? 1 : 0, t: 1000 + i })));
assert.equal(mem("S", 1000), null);                 // nothing settled yet
assert.equal(mem("S", 1020).n, 20);                 // only the first 20
assert.equal(mem("S", 1020).bias, 0.5);             // all YES at 50¢ so far
assert.equal(mem("S").n, 30); assert.equal(mem("X"), null);
// Memory predictor: no change below minN, shrunk shift above it.
assert.equal(PRED.memory({ mid: 0.5, series: "S", at: 1005 }, { recall: mem }), 0.5);       // n=5 < minN
assert.equal(Math.round(PRED.memory({ mid: 0.5, series: "S", at: 1020 }, { recall: mem }) * 1e4), 5000 + 2500); // 0.5 + 20/40×0.5
const e2 = estimate({ mid: 0.5, ask: 0.51, bid: 0.49, series: "S", at: 1005 }, { recall: mem });
assert.equal(e2.est.market, 0.5); assert.deepEqual(e2.picks, {});              // fair price → no pick
// Trade CSV import: quoted fields, cents, aliases, sells, junk rows.
const csv = parseCsv('Market Ticker,Direction,Type,Contracts,Average Price,Fees\r\nKX-A,Yes,Buy,3,62¢,"$0.05"\nKX-B,No,Sell,1,40,\n,,,,,\n');
assert.equal(csv.length, 3);
const { map } = mapColumns(csv[0]);
assert.deepEqual(normalize(csv[1], map), { ticker: "KX-A", side: "yes", sell: false, price: 0.62, count: 3, fees: 0.05, time: null });
assert.equal(normalize(csv[2], map).sell, true);
assert.equal(hash("KX-A"), hash("KX-A")); assert.notEqual(hash("KX-A-YES"), hash("KX-A-NO"));  // stable, outcome-independent order

// Neural network: gradients match a numerical check; untrained = market; learns a planted signal on unseen data.
{
  const m = init([4, 5, 3, 1], rng(1)); m.W[2] = [[0.3, -0.2, 0.5]];
  const d = { x: [0.2, -0.4, 0.9, 0.1], mid: 0.4, y: 1 }, g = { W: m.W.map(L => L.map(r => r.map(() => 0))), b: m.b.map(r => r.map(() => 0)) };
  backprop(m, d, g);
  for (const [l, i, j] of [[0, 1, 2], [1, 2, 4], [2, 0, 1]]) {
    const w = m.W[l][i][j], e = 1e-6;
    m.W[l][i][j] = w + e; const a = nnLoss(predict(m, d.x, d.mid), d.y); m.W[l][i][j] = w - e; const b = nnLoss(predict(m, d.x, d.mid), d.y); m.W[l][i][j] = w;
    assert.ok(Math.abs((a - b) / (2 * e) - g.W[l][i][j]) < 1e-6, "gradient mismatch");
  }
  assert.equal(predict(init([4, 5, 1], rng(2)), d.x, 0.37).toFixed(6), "0.370000");
  const R = rng(3), data = Array.from({ length: 1200 }, () => { const x = [R() * 2 - 1, R() * 2 - 1, R() * 2 - 1], mid = 0.2 + 0.6 * R();
    const p = 1 / (1 + Math.exp(-(Math.log(mid / (1 - mid)) + 1.2 * x[0]))); return { x, mid, y: R() < p ? 1 : 0 }; });
  const fit = train(data.slice(0, 900), { valFrac: 0.2, hidden: [8, 4] }), test = data.slice(900);
  const nnL = test.reduce((s2, d2) => s2 + nnLoss(predict(fit.model, d2.x, d2.mid), d2.y), 0), mkL = test.reduce((s2, d2) => s2 + nnLoss(d2.mid, d2.y), 0);
  assert.ok(nnL < mkL, "network should beat the market on a planted signal (unseen test data)");
}
// Paper trading: fees per order, Kelly sizing, cash never negative, settlement P&L.
assert.equal(orderFee(0.5, 1), 0.02); assert.equal(orderFee(0.5, 10), 0.18);    // 0.07×10×.25 = 0.175 → 0.18
assert.equal(r4(kellyFraction(0.6, 0.5)), 0.2); assert.equal(kellyFraction(0.4, 0.5), 0);
{
  const rows = [{ ts: "2026-01-01T00:00:00Z", ticker: "A", mid: 0.5, ask: 0.5, bid: 0.48, est: { x: 0.7 }, y: 1, settledAt: "2026-01-01T01:00:00Z" },
                { ts: "2026-01-01T02:00:00Z", ticker: "B", mid: 0.5, ask: 0.5, bid: 0.48, est: { x: 0.7 }, y: 0, settledAt: "2026-01-01T03:00:00Z" }];
  const r = simulate({ id: "t", predictor: "x", sizing: "fixed", frac: 0.5 }, rows);
  assert.equal(r.bets, 2); assert.equal(r.wins, 1); assert.ok(r.cash >= 0);
  assert.equal(r.equity, r4(10 + r.pnl));                                        // money is conserved
  assert.equal(simulate({ id: "c", predictor: null }, rows).equity, 10);          // control never trades
  assert.equal(monteCarlo([0.1, -0.05]), null);                                   // too few bets to simulate
  const mc = monteCarlo(Array(50).fill(0).map((_, i) => (i % 2 ? 0.2 : -0.1)));
  assert.ok(mc.pReachGoal > 0.5 && mc.growthPerBet > 0);
}
console.log("all tests passed");
