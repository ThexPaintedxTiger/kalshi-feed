// Training loop for the neural network predictor (hourly in the Action; FORCE=1 to run now).
// Data: settled markets (backtest + resolved live predictions, excluded categories removed), features as of the
// prediction time. Three steps:
//  1. Walk-forward test (the honest score): train on the earliest blocks, predict the next block it has never seen, repeat.
//  2. Holdout curve: train/validation loss per epoch with early stopping (shown on the dashboard).
//  3. Final model: retrain on all data for the best number of epochs → data/nn/model.json, used by live predictions.
import { config, readJson, writeJson, appendJsonl, readJsonl, r4, allMonthFiles } from "./lib.mjs";
import { features, train, predict, logLoss, FEATURES, learningEvidence } from "./nnlib.mjs";
import { loadSamples, makeRecall, backtestRows, allPredictions, snapshotRows } from "./memory.mjs";

const N = config.nn, now = Date.now(), excluded = new Set(config.scan.excludeCategories || []);
const STATE = "data/nn/state.json", state = readJson(STATE, { lastRun: 0 });
if (process.env.FORCE !== "1" && now - state.lastRun < N.everyMinutes * 6e4) { console.log("nn: trained recently — skipped"); process.exit(0); }

// Dataset (time-ordered, one row per market).
const recall = makeRecall(loadSamples());
const out = Object.fromEntries(readJsonl("data/outcomes.jsonl").map(o => [o.ticker, o.result]));
const rows = [
  ...backtestRows().map(r => ({ ...r, src: "backtest" })),
  ...allPredictions().filter(p => out[p.ticker] === "yes" || out[p.ticker] === "no").map(p => ({ ...p, y: out[p.ticker] === "yes" ? 1 : 0, src: "live" })),
].filter(r => !excluded.has(r.cat));
const seen = new Set(), data = [];
for (const r of rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
  if (seen.has(r.ticker)) continue; seen.add(r.ticker);
  data.push({ ticker: r.ticker, title: r.title, event: r.event, src: r.src, t: Date.parse(r.ts), mid: r.mid, y: r.y, x: features({ ...r, at: Date.parse(r.ts) }, recall) });
}
// Minute snapshots (24/7 streamer): training-only rows, each market's snapshots weighted to a total of 1, and only from
// markets that resolved before the data they are tested against (see train() → opt.extra and the folds below).
const snaps = snapshotRows().filter(r => !excluded.has(r.cat)), perMkt = {};
for (const r of snaps) perMkt[r.ticker] = (perMkt[r.ticker] || 0) + 1;
const extra = snaps.map(r => ({ ticker: r.ticker, src: "minute", t: Date.parse(r.ts), resolvedT: Date.parse(r.resolvesAt), mid: r.mid, y: r.y, w: 1 / perMkt[r.ticker],
  x: features({ ...r, at: Date.parse(r.ts) }, recall) }));
state.lastRun = now; writeJson(STATE, state);
if (data.length < N.minSamples) {
  writeJson("data/nn/model.json", { trained: new Date(now).toISOString(), status: `waiting for data: ${data.length}/${N.minSamples} settled markets`, n: data.length, features: FEATURES, model: null });
  console.log(`nn: ${data.length}/${N.minSamples} samples — not training yet`); process.exit(0);
}
const opts = { hidden: N.hidden, lr: N.lr, l2: N.l2, batch: N.batch, epochs: N.maxEpochs, patience: N.patience, seed: N.seed };

// 1. Walk-forward out-of-sample test.
const K = N.folds, size = Math.ceil(data.length / K), oos = {}, folds = [];
for (let i = 1; i < K; i++) {
  const tr = data.slice(0, i * size), te = data.slice(i * size, (i + 1) * size);
  if (tr.length < 40 || !te.length) continue;
  const teSet = new Set(te.map(d => d.ticker));
  const r = train(tr, { ...opts, valFrac: N.valFrac, extra: extra.filter(e => e.resolvedT < te[0].t && !teSet.has(e.ticker)) });
  for (const d of te) oos[d.ticker] = r4(predict(r.model, d.x, d.mid));
  // Per-fold gap vs market: later folds were trained on more data, so if learning works their gap should shrink.
  const g = te.reduce((s, d) => s + (oos[d.ticker] - d.y) ** 2 - (d.mid - d.y) ** 2, 0) / te.length;
  folds.push({ fold: i, trainN: tr.length, testN: te.length, gap: r4(g) });
}
const tested = data.filter(d => d.ticker in oos);
const diffs = tested.map(d => (oos[d.ticker] - d.y) ** 2 - (d.mid - d.y) ** 2);
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const dm = mean(diffs), sd = Math.sqrt(mean(diffs.map(x => (x - dm) ** 2)) * diffs.length / Math.max(1, diffs.length - 1)), se = sd / Math.sqrt(diffs.length || 1);
const ci = { mean: r4(dm), lo: r4(dm - 1.96 * se), hi: r4(dm + 1.96 * se) };
const verdict = tested.length < config.goals.edge.minResolved ? "insufficient data"
  : ci.hi < 0 ? "beats market (out-of-sample)" : ci.lo > 0 ? "worse than market (out-of-sample)" : "no measurable difference";
const oosStats = { n: tested.length, brierNN: r4(mean(tested.map(d => (oos[d.ticker] - d.y) ** 2))), brierMarket: r4(mean(tested.map(d => (d.mid - d.y) ** 2))),
  logLossNN: r4(mean(tested.map(d => logLoss(oos[d.ticker], d.y)))), logLossMarket: r4(mean(tested.map(d => logLoss(d.mid, d.y)))), brierDiff: ci, verdict,
  folds, ...learningEvidence(tested.map(d => ({ p: oos[d.ticker], mid: d.mid, y: d.y, title: d.title, ticker: d.ticker }))) };

// 2. Holdout curve (early stopping). Note: this validation loss is optimistic because it also picks the epoch.
const hold = train(data, { ...opts, valFrac: N.valFrac, extra });
const va = data.slice(hold.n.train), marketVal = mean(va.map(d => logLoss(d.mid, d.y)));

// 3. Final model on all data.
const fin = train(data, { ...opts, valFrac: 0, epochs: Math.max(1, hold.bestEpoch), extra });
const W0 = fin.model.W[0], imp = FEATURES.map((_, j) => mean(W0.map(row => Math.abs(row[j])))), tot = imp.reduce((s, x) => s + x, 0) || 1;

writeJson("data/nn/model.json", {
  trained: new Date(now).toISOString(), status: "trained", n: data.length, sources: { backtest: data.filter(d => d.src === "backtest").length, live: data.filter(d => d.src === "live").length,
    minuteSnapshots: extra.length, minuteMarkets: Object.keys(perMkt).length, archivedFiles: allMonthFiles("predictions").concat(allMonthFiles("backtest"), allMonthFiles("snapshots")).filter(f => f.includes("/archive/")).length },
  architecture: [FEATURES.length, ...N.hidden, 1], features: FEATURES, model: fin.model,
  holdout: { bestEpoch: hold.bestEpoch, valLoss: r4(hold.valLoss), marketValLoss: r4(marketVal), n: hold.n, curve: hold.curve },
  oos: oosStats, importance: FEATURES.map((f, j) => ({ feature: f, weight: r4(imp[j] / tot) })).sort((a, b) => b.weight - a.weight),
});
writeJson("data/nn/oos.json", oos);
appendJsonl("data/nn/train-log.jsonl", [{ ts: new Date(now).toISOString(), n: data.length, bestEpoch: hold.bestEpoch, valLoss: r4(hold.valLoss), marketValLoss: r4(marketVal),
  oosN: oosStats.n, oosBrierNN: oosStats.brierNN, oosBrierMarket: oosStats.brierMarket, oosDiff: ci.mean, verdict, folds }]);
console.log(`nn: trained on ${data.length} (best epoch ${hold.bestEpoch}); out-of-sample n=${oosStats.n}: Brier nn ${oosStats.brierNN} vs market ${oosStats.brierMarket} (diff ${ci.mean}, 95% ${ci.lo}…${ci.hi}) → ${verdict}`);
