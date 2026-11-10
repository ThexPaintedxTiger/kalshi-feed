// A small neural network in plain JavaScript (no libraries, no cost).
// Design: residual on the market. The network outputs a correction o, and P(YES) = sigmoid(logit(price) + o).
// The output layer starts at zero, so an untrained network predicts exactly the market price, and training only
// moves away from it when the data supports it (L2 penalty + early stopping on later, unseen data).

export const CATS = ["Crypto", "Financials", "Economics", "Commodities", "Climate and Weather", "Politics"];
export const FEATURES = ["price (logit)", "spread", "distance from 50¢", "hour (sin)", "hour (cos)",
  ...CATS.map(c => "cat: " + c), "cat: other", "series gap (shrunk)", "series history size", "series YES rate",
  "price move 30 min", "has 30-min history", "outside estimate − price", "has outside data",
  "minute volatility 30 min", "has minute volatility", "time left (log hours)"];

const clipP = p => Math.min(0.99, Math.max(0.01, p));
export const logit = p => Math.log(clipP(p) / (1 - clipP(p)));
export const sigm = x => 1 / (1 + Math.exp(-x));
export const logLoss = (p, y) => { const q = clipP(p); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); };

// Inputs available before resolution only: price, spread, time of day, category, and series memory as of time `at`.
const outside = r => r.ext?.crypto?.p ?? r.ext?.weather?.p ?? null;
// Minutes from the moment of the estimate to resolution (live rows store leadMin; others from at/ts).
const leadMin = r => r.leadMin ?? Math.max(0, (Date.parse(r.resolvesAt) - (r.at ?? Date.parse(r.ts))) / 6e4);

// From 1-minute mids up to the estimate time T (oldest first, [{t: unix s, mid}]), only points at or before T:
// chg30 = mid now − mid ≥25 min earlier; vol30 = std of minute-to-minute changes over the last 30 min (needs ≥ 5 points).
// Used the same way for live candles, backtest candles and the streamer's minute ticks, so the inputs match.
export function minuteStats(points, T) {
  const p = points.filter(x => x.t <= T && x.t > T - 1800 && Number.isFinite(x.mid)).sort((a, b) => a.t - b.t);
  if (!p.length) return { chg30: null, vol30: null };
  const old = p.find(x => x.t <= T - 1500), d = p.slice(1).map((x, i) => x.mid - p[i].mid);
  const m = d.reduce((s, x) => s + x, 0) / (d.length || 1);
  return { chg30: old ? Math.round((p.at(-1).mid - old.mid) * 1e4) / 1e4 : null,
    vol30: d.length >= 4 ? Math.round(Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / d.length) * 1e4) / 1e4 : null };
}
export function features(r, recall) {
  const d = new Date(r.resolvesAt), h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const s = recall ? recall(r.series, r.at) : null;
  return [logit(r.mid) / 3, (r.ask - r.bid) * 10, Math.abs(r.mid - 0.5) * 2, Math.sin(2 * Math.PI * h / 24), Math.cos(2 * Math.PI * h / 24),
    ...CATS.map(c => (r.cat === c ? 1 : 0)), CATS.includes(r.cat) ? 0 : 1,
    s ? (s.n / (s.n + 20)) * s.bias * 5 : 0, s ? Math.log1p(s.n) / 5 : 0, s ? s.yesRate - 0.5 : 0,
    r.chg30 == null ? 0 : Math.max(-1, Math.min(1, r.chg30 * 5)), r.chg30 == null ? 0 : 1,
    outside(r) == null ? 0 : Math.max(-1, Math.min(1, (logit(outside(r)) - logit(r.mid)) / 3)), outside(r) == null ? 0 : 1,
    r.vol30 == null ? 0 : Math.min(1, r.vol30 * 50), r.vol30 == null ? 0 : 1, Math.log1p(leadMin(r) / 60) / 2];
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
  let delta = [(p - d.y) * (d.w ?? 1)];                                     // w < 1: minute snapshots share one market's weight
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
  // opt.extra: training-only rows (minute snapshots). Only those whose market resolved before the held-out part begins.
  const va = data.slice(cut), vaStart = va.length ? va[0].t : Infinity;
  const tr = [...data.slice(0, cut), ...(opt.extra || []).filter(e => e.resolvedT < vaStart)];
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

// Learning evidence from a walk-forward run (unseen markets only).
// rows: [{p, mid, y, title?, ticker?}]. Returns calibration buckets and the worst misses by log loss.
export function learningEvidence(rows, bins = 10, topMisses = 10) {
  const b = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, p: 0, y: 0 }));
  for (const r of rows) { const k = Math.min(bins - 1, Math.floor(r.p * bins)); b[k].n++; b[k].p += r.p; b[k].y += r.y; }
  const r4 = x => Math.round(x * 1e4) / 1e4;
  return {
    calibration: b.filter(x => x.n).map(x => ({ bucket: `${Math.round(x.lo * 100)}-${Math.round(x.hi * 100)}%`, n: x.n, avgP: r4(x.p / x.n), yesRate: r4(x.y / x.n) })),
    misses: rows.map(r => ({ ...r, loss: logLoss(r.p, r.y) })).sort((a, z) => z.loss - a.loss).slice(0, topMisses)
      .map(r => ({ title: r.title || r.ticker || "", net: r4(r.p), market: r4(r.mid), outcome: r.y ? "yes" : "no", loss: r4(r.loss), marketLoss: r4(logLoss(r.mid, r.y)) })),
  };
}
