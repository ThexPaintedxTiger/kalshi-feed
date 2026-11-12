// Offline checks for the math and the leakage guard. Run: node test.mjs
import assert from "node:assert/strict";
import { fee, ev, resolvesAt, hash, r4, firstPerTicker } from "./lib.mjs";
import { brier, logLoss, pnl, score } from "./score.mjs";
import { predictorStatus, health, trend, evaluate } from "./progress.mjs";
import { makeRecall } from "./memory.mjs";
import { PRED, estimate } from "./predictors.mjs";
import { parseCsv, mapColumns, normalize } from "./import-trades.mjs";
import { init, rng, backprop, predict, train, logLoss as nnLoss } from "./nnlib.mjs";
import { orderFee, kellyFraction, simulate, monteCarlo, tradeStats, disagreementReview } from "./paper.mjs";
import { learningEvidence } from "./nnlib.mjs";
import * as CR from "./external/crypto.mjs";
import * as WX from "./external/weather.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { readJsonl as rj, allMonthFiles } from "./lib.mjs";
import { archiveFile, due } from "./archive.mjs";
import { minuteStats, features as nnFeatures, FEATURES as NN_FEATURES } from "./nnlib.mjs";
import { buildSnapshots } from "./snapshots.mjs";
import { bookImbalance, tradeFlow, takerSide } from "./nnlib.mjs";
import { assertReadOnly, assertChannels, signedHeaders, privateIgnored, KEY_FILE } from "./kalshi-auth.mjs";
import { fromFill } from "./import-trades.mjs";
import { generateKeyPairSync, verify, constants as CC } from "node:crypto";
import { spawnSync } from "node:child_process";

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
// Retired predictors are gone from the code (their logged rows stay scored as history).
assert.ok(!("memory" in PRED) && !("longshot" in PRED));
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
// Paper trading: fees per order, Kelly, safety caps, learned sizing, money conserved.
assert.equal(orderFee(0.5, 1), 0.02); assert.equal(orderFee(0.5, 10), 0.18);    // 0.07×10×.25 = 0.175 → 0.18
assert.equal(r4(kellyFraction(0.6, 0.5)), 0.2); assert.equal(kellyFraction(0.4, 0.5), 0);
{
  const mk = (i, y, p = 0.9) => ({ ts: new Date(Date.UTC(2026, 0, 1, 0, i * 10)).toISOString(), ticker: "T" + i, mid: 0.5, ask: 0.5, bid: 0.48, est: { x: p }, y,
    settledAt: new Date(Date.UTC(2026, 0, 1, 0, i * 10 + 5)).toISOString() });
  const rows = [mk(0, 1), mk(1, 0)];
  const big = simulate({ id: "t", predictor: "x", sizing: "fixed", frac: 0.5 }, rows);      // asks for 50%…
  assert.ok(big.maxBetPct <= 5.01, "a single bet must never exceed 5% of the bankroll");    // …gets ≤5%
  assert.ok(big.worstLossPct >= -5.01);
  assert.equal(big.equity, r4(10 + big.pnl));                                              // money is conserved
  assert.equal(simulate({ id: "c", predictor: null }, rows).equity, 10);                   // control never trades
  // Learned sizing: probe size until 30 bets settle; sizes up only once the edge is delivered.
  const learn = { id: "l", predictor: "x", sizing: "learn" };
  const early = simulate(learn, rows);
  assert.ok(early.bets === 2 && early.maxBetPct <= 2.6, "probe bets stay small ($0.25 on $10) while learning");
  const good = simulate(learn, Array.from({ length: 80 }, (_, i) => mk(i, i % 5 ? 1 : 0, 0.75)));   // wins 80% at 50¢
  assert.ok(good.trustNow.trust > 0 && good.maxBetPct > 2.6 && good.maxBetPct <= 5.01, "proven edge → bigger, still capped");
  const bad = simulate(learn, Array.from({ length: 80 }, (_, i) => mk(i, i % 5 ? 0 : 1, 0.75)));    // loses 80%
  assert.equal(bad.trustNow.trust, 0); assert.ok(bad.maxBetPct <= 3.2, "no proven edge → stays at probe size");
  assert.equal(bad.bets, 30); assert.ok(bad.equity > 6.5, "a proven loser stops risking money after its 30 probe bets");
  assert.equal(bad.trustNow.pause, true); assert.ok(bad.shadowBets > 0);
  assert.equal(monteCarlo([0.1, -0.05]), null);                                            // too few bets to simulate
  const mc = monteCarlo(Array(50).fill(0).map((_, i) => (i % 2 ? 0.02 : -0.01)), { paths: 500, seed: 1, horizons: [250, 1000] }, 10);
  assert.ok(mc.growthPerBet > 0 && mc.betsFor100x > 0 && mc.daysFor100x === Math.ceil(mc.betsFor100x / 10));
}
// Trading stats: profit factor, streak, daily P&L, drawdown.
{
  const T = (d, h, pnl) => ({ ts: d + "T00:00:00Z", settledAt: `${d}T0${h}:00:00Z`, pnl, bankroll: 10 });
  const st = tradeStats([T("2026-01-01", 1, 2), T("2026-01-01", 2, -1), T("2026-01-02", 1, 1), T("2026-01-03", 1, 0.5)], [[1, 10], [2, 12], [3, 11], [4, 13]]);
  assert.equal(st.profitFactor, 3.5); assert.equal(st.net, 2.5); assert.equal(st.winRate, 0.75);
  assert.deepEqual(st.streak, { kind: "win", n: 2 }); assert.equal(st.daily.length, 3); assert.equal(st.daily[0].pnl, 1);
  assert.equal(st.drawdown[2][1], r4(-1 / 12 * 100)); assert.equal(st.worst, -1); assert.equal(st.best, 2);
}
// Learning evidence: calibration buckets and worst misses.
{
  const ev2 = learningEvidence([{ p: 0.9, mid: 0.6, y: 0, title: "A" }, { p: 0.15, mid: 0.2, y: 0, title: "B" }, { p: 0.12, mid: 0.2, y: 1, title: "C" }]);
  assert.equal(ev2.misses[0].title, "A");                                   // confident and wrong = worst miss
  assert.deepEqual(ev2.calibration.map(c => c.bucket), ["10-20%", "90-100%"]);
  assert.equal(ev2.calibration[0].n, 2); assert.equal(ev2.calibration[0].yesRate, 0.5);
}
// Loss review: who was closer to the outcome, network or market.
{
  const B = (side, p, mid, won) => ({ side, p, mid, won, pnl: won ? 0.4 : -0.5 });
  const rv = disagreementReview([B("yes", 0.7, 0.5, true), B("yes", 0.7, 0.5, false), B("no", 0.2, 0.4, true), B("no", 0.3, 0.45, false)]);
  assert.equal(rv.n, 4); assert.equal(rv.netCloser, 0.5); assert.equal(rv.losses, 2);
}
// Outside-data agents: probability math, mapping, "doesn't apply" → no estimate.
{
  assert.ok(Math.abs(CR.Phi(0) - 0.5) < 1e-7 && Math.abs(CR.Phi(1.96) - 0.975) < 1e-3);
  const base = { spot: 100, sigmaMin: 0.001, minutes: 100 };                      // σ·√τ = 1%
  assert.ok(Math.abs(CR.fairProb({ ...base, strikeType: "greater", floor: 100 }) - 0.5) < 1e-6);
  assert.ok(CR.fairProb({ ...base, strikeType: "greater", floor: 90 }) > 0.99);   // deep in the money
  assert.ok(CR.fairProb({ ...base, strikeType: "greater", floor: 110 }) < 0.01);
  assert.ok(Math.abs(CR.fairProb({ ...base, strikeType: "less", cap: 100 }) - 0.5) < 1e-6);
  const btw = CR.fairProb({ ...base, strikeType: "between", floor: 99, cap: 101 });
  assert.ok(btw > 0.6 && btw < 0.7);                                               // ±1σ ≈ 68%
  assert.equal(CR.product("KXBTCD"), "BTC-USD"); assert.equal(CR.product("KXHYPED"), null); assert.equal(CR.product("KXINXU"), null);
  assert.equal(WX.tempProb({ F: 60, sigma: 2, strikeType: "greater", floor: 60 }).toFixed(2), "0.50");
  assert.ok(WX.tempProb({ F: 60, sigma: 1, strikeType: "greater", floor: 64 }) < 0.01);
  assert.ok(WX.sigmaFor(0, true) < WX.sigmaFor(3, true) && WX.sigmaFor(30) === 5);
  assert.equal(WX.covers("KXTEMPNYCHS"), true); assert.equal(WX.covers("KXBTCD"), false);
  const e3 = estimate({ mid: 0.5, ask: 0.51, bid: 0.49, series: "KXINXU", at: 1, cat: "Financials", resolvesAt: new Date().toISOString() }, {});
  assert.ok(!("crypto_fair" in e3.est) && !("weather_nws" in e3.est));          // not their market → not scored there
  const e4 = estimate({ mid: 0.5, ask: 0.51, bid: 0.49, series: "KXBTCD", at: 1, cat: "Crypto", resolvesAt: new Date().toISOString(), ext: { crypto: { p: 0.7 } } }, {});
  assert.equal(e4.est.crypto_fair, 0.7); assert.equal(e4.picks.crypto_fair.side, "yes");
}
// Storage tiers: gzip round-trip, verified archive move, hot + archive read as one history.
{
  const root = mkdtempSync(`${tmpdir()}/kf-`), rows = [{ a: 1 }, { a: 2 }, { a: 3 }], txt = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  mkdirSync(`${root}/data/predictions`, { recursive: true });
  writeFileSync(`${root}/x.jsonl.gz`, gzipSync(txt)); assert.deepEqual(rj(`${root}/x.jsonl.gz`), rows);
  writeFileSync(`${root}/data/predictions/2026-01.jsonl`, txt); writeFileSync(`${root}/data/predictions/2026-11.jsonl`, '{"a":4}\n');
  const d = due(root, new Date("2026-11-15T00:00:00Z"));
  assert.deepEqual(d.map(x => x.ym), ["2026-01"]);                                // only months before last month (or oversized)
  const e = archiveFile(d[0].src, "predictions", "2026-01", root);
  assert.equal(e.rows, 3); assert.ok(!existsSync(`${root}/data/predictions/2026-01.jsonl`));
  assert.deepEqual(rj(`${root}/${e.file}`), rows);                                // lossless
  writeFileSync(`${root}/data/predictions/2026-01.jsonl`, '{"a":5}\n');           // a late append to an archived month → becomes a part
  const e2 = archiveFile(`${root}/data/predictions/2026-01.jsonl`, "predictions", "2026-01", root);
  assert.match(e2.file, /2026-01\.part1\.jsonl\.gz$/);
  const cwd = process.cwd(); process.chdir(root);
  try { assert.deepEqual(allMonthFiles("predictions").flatMap(f => rj(f)).map(r => r.a), [1, 2, 3, 5, 4]); }   // nothing forgotten, in order
  finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
}
// Minute data: volatility math, and snapshots never use a tick after their own time (leakage).
{
  const pts = [0, 60, 120, 180, 240, 300, 360].map((t, i) => ({ t: 1000 + t, mid: 0.5 + (i % 2 ? 0.01 : 0) }));
  assert.equal(minuteStats(pts, 1400).vol30, 0.01);                                // alternating ±1¢ → std 1¢
  assert.equal(minuteStats(pts.slice(0, 3), 1400).vol30, null);                     // too few points
  const res = Date.parse("2026-11-10T12:00:00Z"), iso = s => new Date(res - s * 1000).toISOString();
  const ticks = [];
  for (let s = 3600; s >= 0; s -= 60) ticks.push({ t: iso(s), k: "K1", b: s > 600 ? 0.40 : 0.90, a: s > 600 ? 0.42 : 0.92 });   // jumps 10 min before close
  const meta = { K1: { ticker: "K1", resolvesAt: new Date(res).toISOString(), series: "KX", cat: "Crypto", title: "t" } };
  const sn = buildSnapshots(ticks, meta, { K1: "yes" });
  assert.deepEqual(sn.map(r => r.leadMin).sort((a, b) => a - b), [5, 15, 30, 60]);
  for (const r of sn) assert.equal(r.mid, r.leadMin > 10 ? 0.41 : 0.91);            // the jump is invisible before it happened
  assert.equal(buildSnapshots(ticks, meta, {}).length, 0);                           // unresolved → no rows
  assert.equal(buildSnapshots(ticks, meta, { K1: "yes" }, new Set(["K1|5", "K1|15", "K1|30", "K1|60"])).length, 0);   // no duplicates
  const w = sn.map(() => 1 / sn.length).reduce((a, b) => a + b, 0); assert.ok(Math.abs(w - 1) < 1e-9);
  assert.equal(nnFeatures({ ...sn[0], at: Date.parse(sn[0].ts) }, null).length, NN_FEATURES.length);
}
// One prediction per market: the first logged row counts, later repeats are ignored (log untouched).
assert.deepEqual(firstPerTicker([{ ticker: "A", n: 1 }, { ticker: "B", n: 2 }, { ticker: "A", n: 3 }]).map(r => r.n), [1, 2]);
// Kalshi key: read-only by construction. Orders, other methods and non-market channels throw BEFORE anything is signed.
{
  for (const [m, p] of [["POST", "/trade-api/v2/portfolio/orders"], ["DELETE", "/trade-api/v2/portfolio/orders/x"], ["GET", "/trade-api/v2/portfolio/orders"],
    ["GET", "/trade-api/v2/portfolio/balance"], ["PUT", "/trade-api/v2/portfolio/fills"], ["POST", "/trade-api/ws/v2"]])
    assert.throws(() => signedHeaders(m, p, { id: "x", pk: null }), /blocked/);
  assert.equal(assertReadOnly("GET", "/trade-api/v2/portfolio/fills?limit=200"), "/trade-api/v2/portfolio/fills");
  assert.throws(() => assertChannels(["orderbook_delta", "fill"]), /blocked/);
  // Signature format (throwaway key made here, never saved): RSA-PSS SHA-256 over timestamp + method + path without the query.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const h = signedHeaders("GET", "/trade-api/v2/portfolio/fills?limit=5", { id: "kid", pk: privateKey }, 1700000000000);
  assert.equal(h["KALSHI-ACCESS-TIMESTAMP"], "1700000000000");
  assert.ok(verify("sha256", Buffer.from("1700000000000GET/trade-api/v2/portfolio/fills"), { key: publicKey, padding: CC.RSA_PKCS1_PSS_PADDING, saltLength: CC.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64")));
  const ed = generateKeyPairSync("ed25519"), he = signedHeaders("GET", "/trade-api/ws/v2", { id: "kid", pk: ed.privateKey }, 1700000000000);
  assert.ok(verify(null, Buffer.from("1700000000000GET/trade-api/ws/v2"), ed.publicKey, Buffer.from(he["KALSHI-ACCESS-SIGNATURE"], "base64")));   // Ed25519 keys too
  // The key folder is git-ignored, and no tracked file contains a private key.
  assert.ok(privateIgnored(), `${KEY_FILE} must be git-ignored`);
  const leak = spawnSync("git", ["grep", "-lE", "-----BEGIN [A-Z ]*PRIV" + "ATE KEY-----"], { encoding: "utf8" }).stdout.trim();
  assert.equal(leak, "", `private key text in tracked files: ${leak}`);
}
// Order book + trade flow inputs (same formulas for public REST and the keyed stream), and no leakage from later trades.
{
  assert.equal(bookImbalance([["0.40", "30"], ["0.41", "10"]], [["0.55", "20"]]), 0.3333);        // (40 − 20) / 60
  assert.equal(bookImbalance([], []), null);
  assert.equal(bookImbalance([[0.1, 1], [0.2, 1], [0.3, 1], [0.4, 1], [0.5, 1], [0.05, 100]], [[0.4, 5]]), 0);   // only the top 5 levels count
  const tr = [{ t: 100, side: "yes", n: 30 }, { t: 200, side: "no", n: 10 }, { t: 2000, side: "no", n: 999 }];
  assert.deepEqual(tradeFlow(tr, 1000), { flow30: 0.5, vol30t: 40 });                              // the trade at t=2000 is in the future
  assert.deepEqual(tradeFlow([], 1000), { flow30: null, vol30t: 0 });
  assert.equal(takerSide({ taker_book_side: "bid", taker_side: "no" }), "yes");                       // newer field wins
  assert.equal(takerSide({ taker_outcome_side: "no" }), "no"); assert.equal(takerSide({ taker_side: "yes" }), "yes"); assert.equal(takerSide({}), null);
  const res = Date.parse("2026-11-10T12:00:00Z"), iso = s => new Date(res - s * 1000).toISOString(), ticks = [];
  for (let s = 3600; s >= 0; s -= 60) ticks.push({ t: iso(s), k: "K2", b: 0.4, a: 0.42, im: s > 600 ? 0.1 : -0.9, ty: s > 600 ? 1 : 0, tn: s > 600 ? 0 : 50 });
  const sn = buildSnapshots(ticks, { K2: { ticker: "K2", resolvesAt: new Date(res).toISOString() } }, { K2: "yes" });
  for (const r of sn.filter(r => r.leadMin >= 15)) { assert.equal(r.imb5, 0.1); assert.equal(r.flow30, 1); }   // late selling invisible earlier
  assert.equal(nnFeatures({ ...sn[0], at: Date.parse(sn[0].ts) }, null).length, NN_FEATURES.length);
  assert.deepEqual(fromFill({ ticker: "kx-a", side: "no", action: "buy", no_price_dollars: "0.3500", count_fp: "4.00", created_time: "t" }),
    { ticker: "KX-A", side: "no", sell: false, price: 0.35, count: 4, fees: null, time: "t" });
}
await import("./tests/core.test.mjs");
await import("./tests/live.test.mjs");
await import("./tests/models.test.mjs");
console.log("all tests passed");
