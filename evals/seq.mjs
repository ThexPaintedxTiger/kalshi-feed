// Peeking-safe verdicts. The dashboard is watched constantly, and an ordinary 95% interval checked after every new
// result will eventually exclude zero by luck alone. A confidence SEQUENCE is valid at every moment simultaneously:
// the chance it EVER excludes the true mean, no matter how often or when we look, is at most alpha.
//
// Method: predictable plug-in empirical-Bernstein confidence sequence for bounded observations
// (Waudby-Smith & Ramdas, "Estimating means of bounded random variables by betting", 2023, Thm 2).
// It adapts to the observed variance, so small, steady differences are detected far sooner than with a worst-case bound.
// Observations must lie in [lo, hi] (Brier differences are in [−1, 1]; per-contract P&L in [−1.07, 1]).
// Units are EVENTS in the order they resolved (markets in one event are averaged first: they are not independent).
const r6 = x => Math.round(x * 1e6) / 1e6;

// The bet size λ may be ANY function of earlier observations (validity never depends on it); it only affects how fast the
// interval narrows. v0 is the starting guess for the variance (in units of the [0,1]-scaled data): small, because real
// differences between a model and the market are a few points at most. A wrong guess costs width, never validity.
export function confSeq(xs, { alpha = 0.05, lo = -1, hi = 1, v0 = 0.0025 } = {}) {
  const n = xs.length, range = hi - lo;
  if (!n) return { n: 0, mean: null, lo: null, hi: null, alpha };
  const L = Math.log(2 / alpha);
  let sumX = 0, sumSq = 0, sLam = 0, sLamX = 0, sPsi = 0, bestLo = 0, bestHi = 1, mean = 0, tot = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.min(1, Math.max(0, (xs[i] - lo) / range)), t = i + 1;
    const muPrev = (0.5 + sumX) / (i + 1), varPrev = (v0 + sumSq) / (i + 1);            // from observations BEFORE this one (predictable)
    const lam = Math.min(0.5, Math.sqrt(2 * L / (varPrev * t * Math.log(1 + t))));
    sLam += lam; sLamX += lam * x; sPsi += 4 * (x - muPrev) ** 2 * (-Math.log(1 - lam) - lam) / 4;
    sumX += x; const mu = (0.5 + sumX) / (t + 1); sumSq += (x - mu) ** 2; tot += xs[i];
    const c = sLamX / sLam, w = (L + sPsi) / sLam;
    bestLo = Math.max(bestLo, c - w); bestHi = Math.min(bestHi, c + w);                    // running intersection stays valid
    mean = tot / t;
  }
  return { n, mean: r6(mean), lo: r6(lo + range * bestLo), hi: r6(lo + range * Math.min(1, Math.max(bestLo, bestHi))), alpha };
}

// Per-event means in resolution order. rows: [{ event, order (ms), v }].
export function eventSeries(rows) {
  const ev = new Map();
  for (const r of rows) { const e = ev.get(r.event) || ev.set(r.event, { s: 0, n: 0, order: -Infinity }).get(r.event); e.s += r.v; e.n++; if (r.order > e.order) e.order = r.order; }
  return [...ev.values()].sort((a, b) => a.order - b.order).map(e => e.s / e.n);
}
export const seqVerdict = (rows, opt) => confSeq(eventSeries(rows), opt);
