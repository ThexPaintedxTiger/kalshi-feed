// Models and evals: confidence sequence (peeking-safe), calib, ensemble, leakage eval, referee statuses.
import assert from "node:assert/strict";
import { confSeq, eventSeries } from "../evals/seq.mjs";
import { leakage } from "../evals/leakage.mjs";
import { evaluateModel, family } from "../evals/report.mjs";
import * as calib from "../models/calib.mjs";
import * as ens from "../models/ensemble.mjs";
import { rng, train as nnTrain, predict as nnPredict } from "../nnlib.mjs";
import { config } from "../lib.mjs";

const rand = rng(11), gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// ---- Confidence sequence. Under "no difference", checking after every result must almost never cry wolf, while an
//      ordinary 95% interval checked the same way does so in a large share of runs. With a real edge it must find it.
{
  let seqFalse = 0, naiveFalse = 0, found = 0; const PATHS = 120, N = 800;
  for (let p = 0; p < PATHS; p++) {
    const null_ = [], edge = []; let s = 0, s2 = 0, naive = false, seq = false, hit = false;
    for (let i = 0; i < N; i++) {
      const x = Math.max(-0.2, Math.min(0.2, 0.05 * gauss())); null_.push(x); edge.push(Math.max(-0.2, Math.min(0.2, x - 0.012))); s += x; s2 += x * x;
      if (i >= 29) { const m = s / (i + 1), se = Math.sqrt((s2 / (i + 1) - m * m) / (i + 1)); if (Math.abs(m) > 1.96 * se) naive = true; }
      if ((i + 1) % 40 === 0) { const c = confSeq(null_, { lo: -0.2, hi: 0.2 }); if (c.hi < 0 || c.lo > 0) seq = true; if (confSeq(edge, { lo: -0.2, hi: 0.2 }).hi < 0) hit = true; }
    }
    seqFalse += seq; naiveFalse += naive; found += hit;
  }
  assert.ok(seqFalse / PATHS <= 0.05, `sequence false alarms ${seqFalse}/${PATHS}`);
  assert.ok(naiveFalse / PATHS >= 0.2, `naive peeking false alarms only ${naiveFalse}/${PATHS}?`);
  assert.ok(found / PATHS >= 0.9, `real edge found in only ${found}/${PATHS}`);
  const c = confSeq([0.1, -0.1, 0.05], { lo: -1, hi: 1 }); assert.ok(c.lo <= c.mean && c.mean <= c.hi && c.lo >= -1 && c.hi <= 1);
  assert.deepEqual(confSeq([]), { n: 0, mean: null, lo: null, hi: null, alpha: 0.05 });
  assert.ok(confSeq(Array(300).fill(-0.05), { alpha: 0.001, lo: -0.2, hi: 0.2 }).hi > confSeq(Array(300).fill(-0.05), { alpha: 0.05, lo: -0.2, hi: 0.2 }).hi);   // more variants tried → stricter
  // Events: markets of one event are averaged first, and events are ordered by when they resolved.
  assert.deepEqual(eventSeries([{ event: "B", order: 2, v: 1 }, { event: "A", order: 1, v: 0.2 }, { event: "A", order: 1, v: 0.4 }]).map(x => +x.toFixed(2)), [0.3, 1]);
}

// ---- calib: starts as the market, learns a planted bias on unseen later markets, stays within its cap, never trains on the future.
{
  const mk = (i, biased) => { const mid = 0.1 + 0.8 * rand(), cat = i % 2 ? "Crypto" : "Economics", pTrue = Math.min(0.97, Math.max(0.03, mid + (biased && cat === "Crypto" ? 0.08 : 0)));
    const r = { ts: new Date(1e12 + i * 6e5).toISOString(), resolvesAt: new Date(1e12 + i * 6e5 + 36e5).toISOString(), mid, ask: mid + 0.01, bid: mid - 0.01, cat, series: "S", leadMin: 60 };
    return { ticker: "K" + i, event: "E" + i, cat, primary: true, src: "backtest", t: 1e12 + i * 6e5, known: 1e12 + i * 6e5 + 36e5, mid, y: rand() < pTrue ? 1 : 0, w: 1, x: calib.features(r, null) }; };
  const rows = Array.from({ length: 3000 }, (_, i) => mk(i, true));
  assert.equal(calib.FEATURES.length, rows[0].x.length);
  assert.ok(Math.abs(calib.raw(calib.PRIOR, rows[0].x) - rows[0].mid) < 1e-9);                       // untrained = the market price
  const { oos, leaks } = calib.walkForward(rows, { l2: 20, maxDev: 0.1 }), te = rows.filter(r => r.ticker in oos);
  assert.equal(leaks, 0); assert.ok(te.length > 2000);
  const gain = te.reduce((s, r) => s + (oos[r.ticker] - r.y) ** 2 - (r.mid - r.y) ** 2, 0) / te.length;
  assert.ok(gain < -0.0005, `calib did not learn the planted bias (${gain})`);
  assert.ok(te.every(r => Math.abs(oos[r.ticker] - r.mid) <= 0.1 + 1e-4));                            // capped deviation (estimates are stored to 4 decimals)
  const w = calib.fit(rows, { l2: 20 }); assert.ok(w[11] > 0.1, "Crypto weight should be positive");
  // Outcomes only known later than every test block → nothing may be trained → no estimates at all.
  assert.deepEqual(calib.walkForward(rows.map(r => ({ ...r, known: 9e15 })), { l2: 20 }).oos, {});
  // On pure noise (market is right) a strongly shrunk fit stays at the market.
  const noise = Array.from({ length: 2000 }, (_, i) => mk(i, false)), wn = calib.fit(noise, { l2: 200 });
  assert.ok(Math.abs(wn[1] - 1) < 0.1 && wn.slice(2).every(x => Math.abs(x) < 0.15));
}

// ---- Ensemble: weight goes to the member that carries information; an absent member counts as the market.
{
  const data = Array.from({ length: 1500 }, (_, i) => { const mid = 0.2 + 0.6 * rand(), pT = Math.min(0.95, Math.max(0.05, mid + (i % 2 ? 0.1 : -0.1))); return { mid, y: rand() < pT ? 1 : 0, est: { good: pT, junk: Math.min(0.95, Math.max(0.05, mid + 0.2 * (rand() - 0.5))) } }; });
  const w = ens.fit(data, ["good", "junk"], { l2: 5 });
  assert.ok(w[2] > 0.5 && Math.abs(w[3]) < 0.25, JSON.stringify(w));
  const E = { members: ["good", "junk"], w: [0, 1, 0, 0], maxDev: 0.1 };
  assert.ok(Math.abs(ens.predict(E, { good: 0.9 }, 0.4) - 0.4) < 1e-9);                               // prior weights = market
  assert.equal(ens.predict({ ...E, w: [0, 1, 5, 0] }, { good: 0.9 }, 0.4), 0.5);                      // capped at +0.10
}

// ---- Network warm start: fine-tuning from existing weights starts where they left off.
{
  const d = Array.from({ length: 200 }, (_, i) => ({ x: [rand() - 0.5, rand() - 0.5], mid: 0.5, y: i % 2, t: i }));
  const a = nnTrain(d, { hidden: [4], epochs: 5, seed: 3 }), b = nnTrain(d, { hidden: [4], epochs: 0, seed: 3, init: a.model });
  assert.equal(nnPredict(b.model, d[0].x, 0.5), nnPredict(a.model, d[0].x, 0.5));
}

// ---- Leakage eval catches each kind of future data.
{
  const P = (k, ts, extra = {}) => ({ ticker: k, ts, resolvesAt: "2026-01-01T12:00:00Z", ...extra });
  const store = { preds: [P("ok", "2026-01-01T10:00:00Z", { ext: { crypto: { at: "2026-01-01T10:00:20Z" } } }), P("late", "2026-01-01T12:30:00Z"), P("extFuture", "2026-01-01T10:00:00Z", { loggedAt: "2026-01-01T10:00:30Z", ext: { crypto: { at: "2026-01-01T10:05:00Z" } } })],
    out: new Map([["late", { result: "yes", settledAt: "2026-01-01T12:05:00Z" }]]),
    backtest: [{ ticker: "b1", ts: "2026-01-01T12:10:00Z", resolvesAt: "2026-01-01T12:00:00Z" }, { ticker: "b2", ts: "2026-01-01T11:30:00Z", resolvesAt: "2026-01-01T12:00:00Z" }],
    snapshots: [{ ticker: "s1", ts: "2026-01-01T11:45:00Z", resolvesAt: "2026-01-01T12:00:00Z", leadMin: 15 }, { ticker: "s2", ts: "2026-01-01T12:00:01Z", resolvesAt: "2026-01-01T12:00:00Z", leadMin: 5 }] };
  const L = leakage(store, { walk: { calib: 2 }, rag: [{ id: "r1", at: "2026-01-02", asOf: "2026-01-01" }, { id: "r0", at: "2025-12-01", asOf: "2026-01-01" }], facts: [{ id: "f1", at: "2026-01-01T10:00:00Z", asOf: "2026-01-01T10:00:00Z" }] });
  assert.deepEqual(L.checks.map(c => c.violations), [1, 1, 1, 1, 2, 1, 1]); assert.equal(L.total, 8);
  assert.equal(leakage({ preds: [store.preds[0]], out: new Map(), backtest: [store.backtest[1]], snapshots: [store.snapshots[0]] }).total, 0);
}

// ---- Referee statuses. alpha is split across every predictor and variant ever tried.
{
  assert.ok(family() >= 7);
  const rows = Array.from({ length: 600 }, (_, i) => { const y = i % 2, mid = 0.5; return { ticker: "R" + i, event: "RE" + i, known: i, cat: i % 3 ? "Crypto" : "Economics", leadMin: 30 + (i % 5) * 60, y, ask: 0.51, bid: 0.49,
    est: { market: mid, good: y ? 0.6 : 0.4, bad: y ? 0.4 : 0.6, same: mid, few: i < 10 ? 0.6 : undefined }, picks: { good: { side: y ? "yes" : "no", cost: 0.51 } } }; });
  for (const r of rows) if (r.est.few === undefined) delete r.est.few;
  const G = { minResolved: 100, minPicks: 100, retireAfter: 300, minForTrend: 20 }, ev = k => evaluateModel(k, rows, { alpha: 0.05 / 13, G, maxDev: 0.1 });
  const good = ev("good"); assert.equal(good.status, "SUCCESS"); assert.ok(good.vsMarket.sequence.hi < 0 && good.money.sequence.lo > 0);
  assert.equal(good.byCategory.reduce((s, c) => s + c.n, 0), 600); assert.equal(good.byLead.length, 4); assert.ok(good.calibration.length === 2);
  assert.equal(ev("bad").status, "FAILURE_WORSE"); assert.equal(ev("same").status, "SAME_AS_MARKET"); assert.equal(ev("few").status, "INSUFFICIENT");
  assert.equal(evaluateModel("good", rows.slice(0, 60), { alpha: 0.05 / 13, G, maxDev: 0.1 }).status, "ON_TRACK");   // leaning better, far too early to call
  assert.ok(config.models.calib.maxDev <= 0.1 && config.evals.frozenAt);
}
