// Stacked ensemble: a logistic blend of the active models' estimates,
//     P = σ( b + Σ_k w_k · logit(p_k) ),  starting at w_market = 1 and pulled toward it (L2).
// A model that isn't available for a market contributes the market price (so its weight has nothing to add there).
// Trained only on estimates each model made for markets it had not trained on (walk-forward / live), never in-sample.
import { config, r4 } from "../lib.mjs";

const clipP = p => Math.min(0.99, Math.max(0.01, p)), logit = p => Math.log(clipP(p) / (1 - clipP(p))), sigm = z => 1 / (1 + Math.exp(-z));
export const xOf = (members, est, mid) => [1, logit(mid), ...members.map(k => logit(est[k] ?? mid) - logit(mid))];     // members as differences from the market
export function predict(E, est, mid) { const x = xOf(E.members, est, mid), p = sigm(E.w.reduce((s, w, j) => s + w * x[j], 0)), d = E.maxDev ?? 0.1; return clipP(Math.min(mid + d, Math.max(mid - d, p))); }

// rows: [{ est: { model: p }, mid, y, w? }]. Gradient descent is plenty for ≤ 6 weights.
export function fit(rows, members, { l2 = 20, iters = 400, lr = 0.5 } = {}) {
  const d = 2 + members.length, prior = [0, 1, ...members.map(() => 0)], w = prior.slice(), X = rows.map(r => xOf(members, r.est, r.mid)), W = rows.reduce((s, r) => s + (r.w ?? 1), 0) || 1;
  for (let it = 0; it < iters; it++) {
    const g = Array(d).fill(0);
    rows.forEach((r, i) => { const e = (sigm(w.reduce((s, wj, j) => s + wj * X[i][j], 0)) - r.y) * (r.w ?? 1); for (let j = 0; j < d; j++) g[j] += e * X[i][j]; });
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] + (j ? l2 * (w[j] - prior[j]) : 0)) / (W + l2);
  }
  return w.map(x => Math.round(x * 1e5) / 1e5);
}

// members' out-of-sample estimates: oos = { model: { ticker: p } }; rows = calib.trainingRows (primary rows only are used).
export function run(ctx, rows, oos) {
  const M = config.models.ensemble, members = M.members.filter(k => config.predictors[k]?.on || k in oos);
  const data = rows.filter(r => r.primary && members.some(k => oos[k]?.[r.ticker] != null)).map(r => ({ est: Object.fromEntries(members.map(k => [k, oos[k]?.[r.ticker]]).filter(([, v]) => v != null)), mid: r.mid, y: r.y, ticker: r.ticker, t: r.t, known: r.known }));
  if (data.length < (M.minRows ?? 200)) return ctx.emit("ensemble", { trained: new Date().toISOString(), members, w: [0, 1, ...members.map(() => 0)], n: data.length, maxDev: M.maxDev, status: `waiting: ${data.length}/${M.minRows ?? 200} rows with out-of-sample member estimates` }, "state");
  const w = fit(data, members, { l2: M.l2 });
  return ctx.emit("ensemble", { trained: new Date().toISOString(), members, w, n: data.length, maxDev: M.maxDev, status: "trained",
    weights: Object.fromEntries([["market", r4(w[1])], ...members.map((k, i) => [k, r4(w[2 + i])])]) }, "state");
}
// Walk-forward estimates of the blend itself (for development evidence): refit on earlier-known rows per block.
export function walkForward(data, members, { l2 = 20, block = 200, minTrain = 300, maxDev = 0.1 } = {}) {
  const oos = {}; data = [...data].sort((a, b) => a.t - b.t);
  for (let i = 0; i < data.length; i += block) {
    const te = data.slice(i, i + block), tr = data.filter(r => r.known < te[0].t); if (tr.length < minTrain) continue;
    const E = { members, w: fit(tr, members, { l2, iters: 150 }), maxDev };
    for (const r of te) oos[r.ticker] = r4(predict(E, r.est, r.mid));
  }
  return oos;
}
