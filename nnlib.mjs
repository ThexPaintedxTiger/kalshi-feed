// A small neural network in plain JavaScript (no libraries, no cost).
// Design: residual on the market. The network outputs a correction o, and P(YES) = sigmoid(logit(price) + o).
// The output layer starts at zero, so an untrained network predicts exactly the market price, and training only
// moves away from it when the data supports it (L2 penalty + early stopping on later, unseen data).

export const CATS = ["Crypto", "Financials", "Economics", "Commodities", "Climate and Weather", "Politics"];
export const FEATURES = ["price (logit)", "spread", "distance from 50¢", "hour (sin)", "hour (cos)",
  ...CATS.map(c => "cat: " + c), "cat: other", "series gap (shrunk)", "series history size", "series YES rate",
  "price move 30 min", "has 30-min history"];

const clipP = p => Math.min(0.99, Math.max(0.01, p));
export const logit = p => Math.log(clipP(p) / (1 - clipP(p)));
export const sigm = x => 1 / (1 + Math.exp(-x));
export const logLoss = (p, y) => { const q = clipP(p); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); };

// Inputs available before resolution only: price, spread, time of day, category, and series memory as of time `at`.
export function features(r, recall) {
  const d = new Date(r.resolvesAt), h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const s = recall ? recall(r.series, r.at) : null;
  return [logit(r.mid) / 3, (r.ask - r.bid) * 10, Math.abs(r.mid - 0.5) * 2, Math.sin(2 * Math.PI * h / 24), Math.cos(2 * Math.PI * h / 24),
    ...CATS.map(c => (r.cat === c ? 1 : 0)), CATS.includes(r.cat) ? 0 : 1,
    s ? (s.n / (s.n + 20)) * s.bias * 5 : 0, s ? Math.log1p(s.n) / 5 : 0, s ? s.yesRate - 0.5 : 0,
    r.chg30 == null ? 0 : Math.max(-1, Math.min(1, r.chg30 * 5)), r.chg30 == null ? 0 : 1];
}

export function rng(seed) { // mulberry32: same seed → same training run
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function init(sizes, rand) {
  const W = [], b = [];
  for (let l = 0; l < sizes.length - 1; l++) {
    const last = l === sizes.length - 2, sc = Math.sqrt(6 / (sizes[l] + sizes[l + 1]));
    W.push(Array.from({ length: sizes[l + 1] }, () => Array.from({ length: sizes[l] }, () => (last ? 0 : (rand() * 2 - 1) * sc))));
    b.push(Array(sizes[l + 1]).fill(0));
  }
  return { sizes, W, b };
}

export function forward(m, x) {
  const acts = [x];
  let a = x;
  for (let l = 0; l < m.W.length; l++) {
    const z = m.W[l].map((row, i) => row.reduce((s, w, j) => s + w * a[j], m.b[l][i]));
    a = l < m.W.length - 1 ? z.map(Math.tanh) : z;
    acts.push(a);
  }
  return { acts, out: a[0] };
}

export const predict = (m, x, mid) => sigm(logit(mid) + forward(m, x).out);
const clone = m => JSON.parse(JSON.stringify(m));
const zeros = m => ({ W: m.W.map(L => L.map(r => r.map(() => 0))), b: m.b.map(r => r.map(() => 0)) });
export const meanLoss = (m, data) => data.reduce((s, d) => s + logLoss(predict(m, d.x, d.mid), d.y), 0) / (data.length || 1);

// Gradient of log loss for one sample, added into g. dL/dz_out = p − y.
export function backprop(m, d, g) {
  const { acts, out } = forward(m, d.x), p = sigm(logit(d.mid) + out);
  let delta = [p - d.y];
  for (let l = m.W.length - 1; l >= 0; l--) {
    const a = acts[l];
    for (let i = 0; i < delta.length; i++) { g.b[l][i] += delta[i]; for (let j = 0; j < a.length; j++) g.W[l][i][j] += delta[i] * a[j]; }
    if (l > 0) delta = a.map((aj, j) => m.W[l].reduce((s, row, i) => s + row[j] * delta[i], 0) * (1 - aj * aj));
  }
}

// Mini-batch Adam with L2. With valFrac, the LAST part of the (time-sorted) data is held out and training stops when
// held-out loss stops improving; the best weights are returned. Without valFrac, it trains for exactly `epochs`.
export function train(data, o = {}) {
  const opt = { hidden: [16, 8], epochs: 300, lr: 0.01, l2: 1e-3, batch: 32, patience: 25, seed: 7, valFrac: 0, ...o };
  const rand = rng(opt.seed), nIn = data[0].x.length;
  const cut = opt.valFrac ? Math.floor(data.length * (1 - opt.valFrac)) : data.length;
  const tr = data.slice(0, cut), va = data.slice(cut);
  let m = init([nIn, ...opt.hidden, 1], rand);
  const M = zeros(m), V = zeros(m); let t = 0;
  const curve = []; let best = { loss: Infinity, model: clone(m), epoch: 0 };
  for (let ep = 1; ep <= opt.epochs; ep++) {
    const idx = tr.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (let s = 0; s < idx.length; s += opt.batch) {
      const bi = idx.slice(s, s + opt.batch), g = zeros(m);
      for (const i of bi) backprop(m, tr[i], g);
      t++;
      const step = (P, G, Mm, Vv, decay) => {
        for (let k = 0; k < P.length; k++) {
          const gr = G[k] / bi.length + (decay ? opt.l2 * P[k] : 0);
          Mm[k] = 0.9 * Mm[k] + 0.1 * gr; Vv[k] = 0.999 * Vv[k] + 0.001 * gr * gr;
          P[k] -= opt.lr * (Mm[k] / (1 - 0.9 ** t)) / (Math.sqrt(Vv[k] / (1 - 0.999 ** t)) + 1e-8);
        }
      };
      m.W.forEach((L, l) => L.forEach((row, i) => step(row, g.W[l][i], M.W[l][i], V.W[l][i], true)));
      m.b.forEach((row, l) => step(row, g.b[l], M.b[l], V.b[l], false));
    }
    const trL = meanLoss(m, tr), vaL = va.length ? meanLoss(m, va) : null;
    curve.push({ epoch: ep, train: +trL.toFixed(5), val: vaL == null ? null : +vaL.toFixed(5) });
    if (va.length) {
      if (vaL < best.loss - 1e-5) best = { loss: vaL, model: clone(m), epoch: ep };
      else if (ep - best.epoch >= opt.patience) break;
    }
  }
  return va.length ? { model: best.model, bestEpoch: best.epoch, curve, valLoss: best.loss, n: { train: tr.length, val: va.length } }
    : { model: m, bestEpoch: opt.epochs, curve, n: { train: tr.length, val: 0 } };
}
