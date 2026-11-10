// Scoring step: join predictions with official outcomes and write scorecard.json.
// Every predictor is compared with the market price on the SAME markets. An "edge" is only claimed when
// enough markets resolved AND the difference is outside ~95% noise, counted per event (markets in one
// event move together, so they aren't independent samples).
import { config, readJsonl, writeJson, clip, r4, fee } from "./lib.mjs";
import { readdirSync, existsSync } from "node:fs";

export function brier(p, y) { return (p - y) ** 2; }
export function logLoss(p, y) { const q = clip(p); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); }
export function pnl(pick, y) { const win = pick.side === "yes" ? y : 1 - y; return r4(win - pick.cost - fee(pick.cost)); }

// Mean and 95% interval of a per-row value, using per-event means as the independent units.
export function clustered(rows, f) {
  const ev = {};
  for (const r of rows) (ev[r.event] ||= []).push(f(r));
  const m = Object.values(ev).map(a => a.reduce((s, x) => s + x, 0) / a.length), n = m.length;
  if (!n) return { mean: null, lo: null, hi: null, events: 0 };
  const mean = m.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(m.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : Infinity, se = sd / Math.sqrt(n);
  return { mean: r4(mean), lo: r4(mean - 1.96 * se), hi: r4(mean + 1.96 * se), events: n };
}

export function score(preds, outcomes, cfg = config) {
  const out = Object.fromEntries(outcomes.map(o => [o.ticker, o]));
  // Leakage guard: a prediction counts only if it was logged before the market resolved/settled.
  const rows = [], leaked = [];
  for (const p of preds) {
    const o = out[p.ticker]; if (!o || (o.result !== "yes" && o.result !== "no")) continue;
    const t = Date.parse(p.ts), cutoff = Math.min(Date.parse(p.resolvesAt), Date.parse(o.settledAt || p.resolvesAt), Date.parse(o.closedAt || p.resolvesAt));
    (t < cutoff ? rows : leaked).push({ ...p, y: o.result === "yes" ? 1 : 0 });
  }
  const names = [...new Set(rows.flatMap(r => Object.keys(r.est)))];
  const enough = rows.length >= cfg.score.minResolved;
  const predictors = {};
  for (const k of names) {
    const rs = rows.filter(r => k in r.est && "market" in r.est);
    const b = clustered(rs, r => brier(r.est[k], r.y)), ll = clustered(rs, r => logLoss(r.est[k], r.y));
    const vsMarket = clustered(rs, r => brier(r.est[k], r.y) - brier(r.est.market, r.y)); // < 0 = better than market
    const pk = rs.filter(r => r.picks?.[k]), money = clustered(pk, r => pnl(r.picks[k], r.y));
    const bins = Array.from({ length: cfg.score.calibrationBins }, () => ({ n: 0, p: 0, y: 0 }));
    for (const r of rs) { const b2 = bins[Math.min(bins.length - 1, Math.floor(r.est[k] * bins.length))]; b2.n++; b2.p += r.est[k]; b2.y += r.y; }
    let verdict = "insufficient data";
    if (k === "market") verdict = "baseline";
    else if (rs.length && rs.every(r => r.est[k] === r.est.market)) verdict = "same as market (not active yet)";
    else if (enough && vsMarket.hi < 0) verdict = "beats market (Brier)";
    else if (enough && vsMarket.lo > 0) verdict = "worse than market (Brier)";
    else if (enough) verdict = "no measurable difference";
    predictors[k] = {
      n: rs.length, brier: b, logLoss: ll, brierVsMarket: vsMarket, verdict,
      picks: { n: pk.length, wins: pk.filter(r => pnl(r.picks[k], r.y) > 0).length, pnlPerContract: money,
        totalPnl: r4(pk.reduce((s, r) => s + pnl(r.picks[k], r.y), 0)),
        profitable: pk.length >= cfg.score.minResolved && money.lo > 0 },
      calibration: bins.map((x, i) => ({ bin: `${i * 100 / bins.length}-${(i + 1) * 100 / bins.length}%`, n: x.n,
        avgP: x.n ? r4(x.p / x.n) : null, hitRate: x.n ? r4(x.y / x.n) : null })).filter(x => x.n),
    };
  }
  const byCat = {};
  for (const r of rows) { const c = (byCat[r.cat || "?"] ||= { n: 0, brierMarket: 0 }); c.n++; c.brierMarket += brier(r.est.market, r.y); }
  for (const c of Object.values(byCat)) c.brierMarket = r4(c.brierMarket / c.n);
  return {
    updated: new Date().toISOString(),
    note: "Simulation only. Brier/log loss: lower is better. brierVsMarket < 0 means better than the market price. " +
      "Intervals are 95%, counted per event. No edge is claimed below " + cfg.score.minResolved + " resolved predictions.",
    predictions: preds.length, resolved: rows.length, excludedLeakage: leaked.length, events: new Set(rows.map(r => r.event)).size,
    predictors, byCategory: byCat,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = "data/predictions";
  const preds = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort().flatMap(f => readJsonl(`${dir}/${f}`)) : [];
  const sc = score(preds, readJsonl("data/outcomes.jsonl"));
  writeJson("scorecard.json", sc);
  console.log(`scorecard: ${sc.predictions} predictions, ${sc.resolved} resolved, ` +
    Object.entries(sc.predictors).map(([k, v]) => `${k} brier ${v.brier.mean} (${v.verdict})`).join("; "));
}
