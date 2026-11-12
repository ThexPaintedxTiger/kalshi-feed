// calib — the primary model: a logistic correction of the market price.
//     P(YES) = σ( a·logit(mid) + b + w·x )
// It starts as the market itself (a = 1, everything else 0) and is pulled back toward the market by an L2 penalty, so it
// only moves away where settled markets support it. ~14 numbers, refit in milliseconds on every settlement (warm start).
// Its estimate never differs from the market by more than `maxDev` (config.models.calib.maxDev): a risk limit, and it
// makes the peeking-safe test much sharper (the Brier difference is then bounded by 2·maxDev instead of 1).
// Features use only what was known at the estimate time; missing inputs are 0 (neutral).
import { config, r4 } from "../lib.mjs";

export const FEATURES = ["bias", "logit(mid)", "time left (log h)", "spread", "microprice − mid", "book imbalance", "trade flow 30 min", "volatility 30 min",
  "price move 30 min", "outside estimate − price", "series gap (shrunk)", "cat: Crypto", "cat: Financials", "cat: Commodities", "cat: Climate and Weather"];
const CATS = ["Crypto", "Financials", "Commodities", "Climate and Weather"];
const clipP = p => Math.min(0.99, Math.max(0.01, p)), logit = p => Math.log(clipP(p) / (1 - clipP(p))), sigm = z => 1 / (1 + Math.exp(-z));
const cl = (x, a = 1) => Math.max(-a, Math.min(a, x));
export const PRIOR = FEATURES.map((_, j) => (j === 1 ? 1 : 0));

export function features(r, recall) {
  const lead = r.leadMin ?? Math.max(0, (Date.parse(r.resolvesAt) - (r.at ?? Date.parse(r.ts))) / 6e4), out = r.ext?.crypto?.p ?? r.ext?.weather?.p ?? null;
  const s = recall ? recall(r.series, r.at ?? Date.parse(r.ts)) : null;
  return [1, logit(r.mid), Math.log1p(lead / 60) / 2, cl((r.spread ?? (r.ask - r.bid) ?? 0) * 10), cl((r.microDiff ?? 0) * 20), r.imb5 ?? 0, r.flow30 ?? 0, cl((r.vol30 ?? 0) * 50),
    cl((r.chg30 ?? 0) * 5), out == null ? 0 : cl((logit(out) - logit(r.mid)) / 3), s ? cl((s.n / (s.n + 20)) * s.bias * 5) : 0, ...CATS.map(c => (r.cat === c ? 1 : 0))];
}
export const raw = (w, x) => sigm(w.reduce((s, wj, j) => s + wj * x[j], 0));
export function predict(w, x, mid, maxDev = config.models?.calib?.maxDev ?? 0.1) { const p = raw(w, x); return Math.min(0.99, Math.max(0.01, Math.min(mid + maxDev, Math.max(mid - maxDev, p)))); }

// Weighted ridge logistic regression by Newton's method. Penalty λ/2·‖w − prior‖² (bias unpenalised). rows: [{ x, y, w? }].
export function fit(rows, { l2 = 50, init = PRIOR, iters = 12 } = {}) {
  const d = FEATURES.length; let w = init.slice();
  if (!rows.length) return w;
  const W = rows.reduce((s, r) => s + (r.w ?? 1), 0);
  for (let it = 0; it < iters; it++) {
    const g = Array(d).fill(0), H = Array.from({ length: d }, () => Array(d).fill(0));
    for (const r of rows) {
      const p = raw(w, r.x), k = r.w ?? 1, e = (p - r.y) * k, h = Math.max(1e-6, p * (1 - p)) * k;
      for (let i = 0; i < d; i++) { g[i] += e * r.x[i]; const hx = h * r.x[i]; for (let j = i; j < d; j++) H[i][j] += hx * r.x[j]; }
    }
    for (let i = 0; i < d; i++) { if (i > 0) { g[i] += l2 * (w[i] - PRIOR[i]); H[i][i] += l2; } else H[i][i] += 1e-6; for (let j = 0; j < i; j++) H[i][j] = H[j][i]; }
    const step = solve(H, g); let max = 0;
    for (let i = 0; i < d; i++) { w[i] -= step[i]; max = Math.max(max, Math.abs(step[i])); }
    if (max < 1e-7) break;
  }
  return w.map(x => Math.round(x * 1e6) / 1e6);
}
function solve(A, b) {                                           // Gaussian elimination with partial pivoting (d ≈ 15)
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; const pv = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / pv; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / (M[r][r] || 1e-12); }
  return x;
}

// Training rows from the store. One primary row per market (its first live prediction, else its backtest row) plus the
// daemon's minute snapshots; all rows of a market share a total weight of 1. `known` = when the outcome became known:
// a row may train a model only for estimates made AFTER that moment.
export function trainingRows(store, recall) {
  const excluded = new Set(config.scan.excludeCategories || []), rows = [], seen = new Set();
  const add = (r, src, y, known, primary) => { const t = Date.parse(r.ts); if (!(r.mid > 0 && r.mid < 1) || excluded.has(r.cat)) return;
    rows.push({ ticker: r.ticker, event: r.event || r.ticker, cat: r.cat, src, primary, t, known, mid: r.mid, y, lead: r.leadMin ?? null, x: features({ ...r, at: t }, recall) }); };
  for (const p of store.preds) { const y = store.result(p.ticker); if (y == null) continue; const o = store.out.get(p.ticker); seen.add(p.ticker); add(p, "live", y, Date.parse(o.settledAt || p.resolvesAt), true); }
  for (const r of store.backtest) { if (seen.has(r.ticker)) continue; seen.add(r.ticker); add(r, "backtest", r.y, Date.parse(r.settledAt || r.resolvesAt), true); }
  for (const r of store.snapshots) { const o = store.out.get(r.ticker); add(r, "minute", r.y, Date.parse(o?.settledAt || r.resolvesAt) + (o?.settledAt ? 0 : 36e5), false); }
  const per = {}; for (const r of rows) per[r.ticker] = (per[r.ticker] || 0) + 1;
  for (const r of rows) r.w = 1 / per[r.ticker];
  return rows.sort((a, b) => a.t - b.t);
}

// Walk-forward ("prequential") test on past data: go through the primary rows in time order in blocks; each block is
// predicted by a model fitted ONLY on rows whose outcome was already known when the block began. Returns ticker → estimate.
// `leaks` counts training rows that would have broken that rule (must be 0; reported by the leakage eval).
export function walkForward(rows, { l2 = 50, block = 100, minTrain = 200, maxDev } = {}) {
  const prim = rows.filter(r => r.primary), oos = {}, byKnown = [...rows].sort((a, b) => a.known - b.known); let w = PRIOR.slice(), leaks = 0, k = 0, train = [];
  for (let i = 0; i < prim.length; i += block) {
    const te = prim.slice(i, i + block), start = te[0].t, teSet = new Set(te.map(r => r.ticker));
    while (k < byKnown.length && byKnown[k].known < start) train.push(byKnown[k++]);
    const tr = train.filter(r => !teSet.has(r.ticker)); leaks += tr.filter(r => r.known >= start).length;
    if (tr.length < minTrain) continue;
    w = fit(tr, { l2, init: w });
    for (const r of te) oos[r.ticker] = r4(predict(w, r.x, r.mid, maxDev));
  }
  return { oos, leaks };
}

// Training step: refit on everything settled (warm start). Cheap enough to run on every settlement.
export function run(ctx) {
  const M = config.models.calib, t0 = performance.now(), rows = trainingRows(ctx.store, ctx.recall), prev = ctx.get("calib", "state");
  if (prev && prev.rows === rows.length && prev.cfg === config.version) return null;                 // nothing new settled
  const w = fit(rows, { l2: M.l2, init: prev?.w?.length === FEATURES.length ? prev.w : PRIOR });
  ctx.emit("calib", { trained: new Date().toISOString(), cfg: config.version, rows: rows.length, markets: new Set(rows.map(r => r.ticker)).size, w, features: FEATURES, l2: M.l2, maxDev: M.maxDev,
    sources: { live: rows.filter(r => r.src === "live").length, backtest: rows.filter(r => r.src === "backtest").length, minute: rows.filter(r => r.src === "minute").length }, ms: Math.round(performance.now() - t0) }, "state");
  return `calib: refit on ${rows.length} rows in ${Math.round(performance.now() - t0)} ms`;
}
