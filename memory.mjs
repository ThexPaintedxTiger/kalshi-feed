// Memory: what we know about each Kalshi series from settled markets we've seen (live record + backtest).
// - recall(series, at): leak-safe lookup using only markets settled BEFORE `at` (used by the memory predictor).
// - data/memory/series.json: human/MCP-readable summary per series (rebuilt each run from the logs; derived, not history).
import { readJsonl, writeJson, readJson, r4, readLog, predictionRows } from "./lib.mjs";

// Samples = settled markets with the market price we logged and the result.
export function loadSamples() {
  const out = Object.fromEntries(readJsonl("data/outcomes.jsonl").map(o => [o.ticker, o]));
  const s = [];
  for (const p of allPredictions()) {
    const o = out[p.ticker]; if (!o || (o.result !== "yes" && o.result !== "no")) continue;
    s.push({ series: p.series, cat: p.cat, ticker: p.ticker, mid: p.mid, y: o.result === "yes" ? 1 : 0, t: Date.parse(o.settledAt || p.resolvesAt), src: "live" });
  }
  for (const r of backtestRows()) s.push({ series: r.series, cat: r.cat, ticker: r.ticker, mid: r.mid, y: r.y, t: Date.parse(r.settledAt || r.resolvesAt), src: "backtest" });
  // One sample per ticker (live wins over backtest).
  const seen = new Set();
  return s.sort((a, b) => (a.src === "live" ? -1 : 1) - (b.src === "live" ? -1 : 1)).filter(x => !seen.has(x.ticker) && seen.add(x.ticker));
}

export function makeRecall(samples) {
  const by = {};
  for (const x of samples) (by[x.series] ||= []).push(x);
  for (const a of Object.values(by)) a.sort((p, q) => p.t - q.t);
  return (series, at = Infinity) => {
    const a = (by[series] || []).filter(x => x.t < at);
    if (!a.length) return null;
    const n = a.length, yes = a.reduce((s, x) => s + x.y, 0), mid = a.reduce((s, x) => s + x.mid, 0);
    return { n, yesRate: r4(yes / n), avgPrice: r4(mid / n), bias: r4((yes - mid) / n),
      brierMarket: r4(a.reduce((s, x) => s + (x.mid - x.y) ** 2, 0) / n), last: new Date(a[n - 1].t).toISOString() };
  };
}

// Full history, hot + archived months (nothing is forgotten as files move to the archive).
export const allPredictions = predictionRows;
export const backtestRows = () => readLog("backtest");
export const snapshotRows = () => readLog("snapshots");

if (import.meta.url === `file://${process.argv[1]}`) {
  const samples = loadSamples(), recall = makeRecall(samples), cats = readJson("data/series.json", { map: {} }).map;
  const series = {};
  for (const t of [...new Set(samples.map(x => x.series))].sort()) {
    const r = recall(t), src = samples.filter(x => x.series === t);
    series[t] = { cat: cats[t] || src[0]?.cat || "", ...r, live: src.filter(x => x.src === "live").length, backtest: src.filter(x => x.src === "backtest").length };
  }
  writeJson("data/memory/series.json", { updated: new Date().toISOString(), samples: samples.length,
    note: "Derived summary (rebuilt each run). bias = average (outcome − market price); > 0 means YES was underpriced in this series.", series });
  console.log(`memory: ${samples.length} settled samples across ${Object.keys(series).length} series`);
}
