// Training loop for the neural network predictor (hourly in the Action; FORCE=1 to run now).
// Data: settled markets (backtest + resolved live predictions, excluded categories removed), features as of the
// prediction time. Three steps:
//  1. Walk-forward test (the honest score): train on the earliest blocks, predict the next block it has never seen, repeat.
//  2. Holdout curve: train/validation loss per epoch with early stopping (shown on the dashboard).
//  3. Final model: retrain on all data for the best number of epochs → data/nn/model.json, used by live predictions.
import { config, appendJsonl, r4, mean } from "./lib.mjs";
import { features, train, predict, logLoss, FEATURES, learningEvidence } from "./nnlib.mjs";
import { clustered } from "./score.mjs";
import { setModel } from "./predictors.mjs";

// Time-ordered dataset, one row per market, features as of the prediction time. Pure: used by the worker thread too.
export function dataset(store, recall) {
  const excluded = new Set(config.scan.excludeCategories || []);
  const rows = [...store.backtest.map(r => ({ ...r, src: "backtest" })),
    ...store.preds.filter(p => store.result(p.ticker) != null).map(p => ({ ...p, y: store.result(p.ticker), src: "live" }))].filter(r => !excluded.has(r.cat));
  const seen = new Set(), data = [];
  for (const r of rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    if (seen.has(r.ticker)) continue; seen.add(r.ticker);
    data.push({ ticker: r.ticker, title: r.title, event: r.event || r.ticker, src: r.src, t: Date.parse(r.ts), mid: r.mid, y: r.y, x: features({ ...r, at: Date.parse(r.ts) }, recall) });
  }
  // Minute snapshots: training-only rows, each market's snapshots weighted to a total of 1, and only from markets that
  // resolved before the data they are tested against (see train() → opt.extra and the folds below).
  const snaps = store.snapshots.filter(r => !excluded.has(r.cat)), perMkt = {};
  for (const r of snaps) perMkt[r.ticker] = (perMkt[r.ticker] || 0) + 1;
  const extra = snaps.map(r => ({ ticker: r.ticker, src: "minute", t: Date.parse(r.ts), resolvedT: Date.parse(r.resolvesAt), mid: r.mid, y: r.y, w: 1 / perMkt[r.ticker], x: features({ ...r, at: Date.parse(r.ts) }, recall) }));
  return { data, extra, minuteMarkets: Object.keys(perMkt).length };
}

// The full training run. Returns { model file, oos map, log row }.
export function trainAll({ data, extra, minuteMarkets }, now = Date.now()) {
  const N = config.nn;
  if (data.length < N.minSamples) return { file: { trained: new Date(now).toISOString(), status: `waiting for data: ${data.length}/${N.minSamples} settled markets`, n: data.length, features: FEATURES, model: null }, oos: {}, log: null };
  const opts = { hidden: N.hidden, lr: N.lr, l2: N.l2, batch: N.batch, epochs: N.maxEpochs, patience: N.patience, seed: N.seed };
  // 1. Walk-forward out-of-sample test.
  const K = N.folds, size = Math.ceil(data.length / K), oos = {}, folds = [];
  for (let i = 1; i < K; i++) {
    const tr = data.slice(0, i * size), te = data.slice(i * size, (i + 1) * size);
    if (tr.length < 40 || !te.length) continue;
    const teSet = new Set(te.map(d => d.ticker));
    const r = train(tr, { ...opts, valFrac: N.valFrac, extra: extra.filter(e => e.resolvedT < te[0].t && !teSet.has(e.ticker)) });
    for (const d of te) oos[d.ticker] = r4(predict(r.model, d.x, d.mid));
    const g = te.reduce((s, d) => s + (oos[d.ticker] - d.y) ** 2 - (d.mid - d.y) ** 2, 0) / te.length;
    folds.push({ fold: i, trainN: tr.length, testN: te.length, gap: r4(g) });
  }
  const tested = data.filter(d => d.ticker in oos);
  // Interval counted per EVENT (markets in one event move together), the same way score.mjs does it.
  const ci = clustered(tested, d => (oos[d.ticker] - d.y) ** 2 - (d.mid - d.y) ** 2);
  const verdict = tested.length < config.goals.edge.minResolved ? "insufficient data"
    : ci.hi < 0 ? "beats market (out-of-sample)" : ci.lo > 0 ? "worse than market (out-of-sample)" : "no measurable difference";
  const oosStats = { n: tested.length, events: ci.events, brierNN: r4(mean(tested.map(d => (oos[d.ticker] - d.y) ** 2))), brierMarket: r4(mean(tested.map(d => (d.mid - d.y) ** 2))),
    logLossNN: r4(mean(tested.map(d => logLoss(oos[d.ticker], d.y)))), logLossMarket: r4(mean(tested.map(d => logLoss(d.mid, d.y)))), brierDiff: ci, interval: "95%, per event", verdict,
    folds, ...learningEvidence(tested.map(d => ({ p: oos[d.ticker], mid: d.mid, y: d.y, title: d.title, ticker: d.ticker }))) };
  // 2. Holdout curve (early stopping). This validation loss is optimistic because it also picks the epoch.
  const hold = train(data, { ...opts, valFrac: N.valFrac, extra });
  const va = data.slice(hold.n.train), marketVal = mean(va.map(d => logLoss(d.mid, d.y)));
  // 3. Final model on all data.
  const fin = train(data, { ...opts, valFrac: 0, epochs: Math.max(1, hold.bestEpoch), extra });
  const W0 = fin.model.W[0], imp = FEATURES.map((_, j) => mean(W0.map(row => Math.abs(row[j])))), tot = imp.reduce((s, x) => s + x, 0) || 1;
  const c = hold.curve, stepC = Math.ceil(c.length / 120) || 1;
  const file = { trained: new Date(now).toISOString(), status: "trained", n: data.length,
    sources: { backtest: data.filter(d => d.src === "backtest").length, live: data.filter(d => d.src === "live").length, minuteSnapshots: extra.length, minuteMarkets },
    architecture: [FEATURES.length, ...N.hidden, 1], features: FEATURES, model: fin.model,
    holdout: { bestEpoch: hold.bestEpoch, valLoss: r4(hold.valLoss), marketValLoss: r4(marketVal), n: hold.n, curve: c.filter((_, i) => i % stepC === 0 || i === c.length - 1) },
    oos: oosStats, importance: FEATURES.map((f, j) => ({ feature: f, weight: r4(imp[j] / tot) })).sort((a, b) => b.weight - a.weight) };
  const log = { ts: file.trained, n: data.length, bestEpoch: hold.bestEpoch, valLoss: r4(hold.valLoss), marketValLoss: r4(marketVal),
    oosN: oosStats.n, oosEvents: ci.events, oosBrierNN: oosStats.brierNN, oosBrierMarket: oosStats.brierMarket, oosDiff: ci.mean, oosLo: ci.lo, oosHi: ci.hi, verdict, folds };
  return { file, oos, log };
}

// Hourly (config.nn.everyMinutes) unless forced. Skips when no new settled market arrived since the last run:
// the seed is fixed, so retraining on the same data would reproduce the same model.
export function run(ctx, { force = false } = {}) {
  const now = Date.now(), prev = ctx.get("nn-model", "state"), st = ctx.nnState ||= { lastRun: prev?.trained ? Date.parse(prev.trained) : 0, n: prev?.n ?? -1 };
  if (!force && now - st.lastRun < config.nn.everyMinutes * 6e4) return "nn: trained recently — skipped";
  const ds = dataset(ctx.store, ctx.recall);
  if (!force && prev?.model && ds.data.length === st.n) { st.lastRun = now; return "nn: no new settled markets since the last run — skipped"; }
  const { file, oos, log } = trainAll(ds, now);
  st.lastRun = now; st.n = ds.data.length;
  ctx.emit("nn-model", file, "state"); ctx.emit("nn-oos", oos, "state"); setModel(file);
  if (!log) return `nn: ${file.status}`;
  appendJsonl("data/nn/train-log.jsonl", [log]);
  const o = file.oos;
  return `nn: trained on ${file.n} (best epoch ${file.holdout.bestEpoch}); out-of-sample n=${o.n} in ${o.events} events: Brier nn ${o.brierNN} vs market ${o.brierMarket} (diff ${o.brierDiff.mean}, 95% per event ${o.brierDiff.lo}…${o.brierDiff.hi}) → ${o.verdict}`;
}
if (import.meta.url === `file://${process.argv[1]}`) { const { makeCtx } = await import("./core/ctx.mjs"); console.log(run(makeCtx(), { force: process.env.FORCE === "1" })); }
