// ladder — structure across the strikes of ONE event (no outside data).
//   "greater" strikes: P(above K) can only fall as K rises.   "less" strikes: P(below K) can only rise.
//   "between" bins of a mutually exclusive set: probabilities must sum to 1.
// We fit the closest monotone curve to the quoted mids (isotonic regression, weighted by 1/spread so tight quotes count
// more). Where the quotes already agree with each other the fit equals the market; it differs only for strikes that sit
// off the curve. Those are flagged, and the fitted value is the `ladder` estimate, scored like any other predictor.
import { r4 } from "../lib.mjs";

// Weighted isotonic regression (pool-adjacent-violators), non-decreasing. pts: [{ v, w }] in x order → fitted values.
export function isotonic(pts) {
  const blocks = [];
  for (const p of pts) { blocks.push({ s: p.v * p.w, w: p.w, n: 1 }); while (blocks.length > 1 && blocks.at(-2).s / blocks.at(-2).w > blocks.at(-1).s / blocks.at(-1).w) { const b = blocks.pop(), a = blocks.at(-1); a.s += b.s; a.w += b.w; a.n += b.n; } }
  return blocks.flatMap(b => Array(b.n).fill(b.s / b.w));
}
const quote = m => { const bid = +m.yes_bid_dollars, ask = +m.yes_ask_dollars; return bid > 0 && ask < 1 && ask > bid ? { mid: (bid + ask) / 2, spread: ask - bid } : null; };

// markets: every market of one event (Kalshi objects). Returns ticker → { p, dev, n, kind, flag, sum? } for the quoted ones.
export function fitEvent(markets, { minStrikes = 3, flagAt = 0.03 } = {}) {
  const out = {};
  for (const kind of ["greater", "less"]) {
    const ms = markets.filter(m => m.strike_type === kind && quote(m) && Number.isFinite(+(kind === "greater" ? m.floor_strike : m.cap_strike ?? m.floor_strike)))
      .map(m => ({ m, K: +(kind === "greater" ? m.floor_strike : m.cap_strike ?? m.floor_strike), ...quote(m) })).sort((a, b) => a.K - b.K);
    if (ms.length < minStrikes) continue;
    // "greater" must be non-increasing in K → fit non-decreasing on the reversed order.
    const seq = kind === "greater" ? [...ms].reverse() : ms, fit = isotonic(seq.map(x => ({ v: x.mid, w: 1 / Math.max(0.01, x.spread) })));
    seq.forEach((x, i) => { const p = Math.min(0.99, Math.max(0.01, fit[i])), dev = r4(p - x.mid); out[x.m.ticker] = { p: r4(p), dev, n: ms.length, kind, flag: Math.abs(dev) >= flagAt }; });
  }
  const bins = markets.filter(m => m.strike_type === "between" && quote(m)), all = markets.filter(m => m.strike_type === "between");
  // Only when EVERY bin of the set is quoted can the sum be checked (a missing bin would make the others look overpriced).
  if (bins.length >= minStrikes && bins.length === all.length) {
    const sum = bins.reduce((s, m) => s + quote(m).mid, 0);
    if (sum > 0.5 && sum < 1.5) for (const m of bins) { const mid = quote(m).mid, p = Math.min(0.99, Math.max(0.01, mid / sum)), dev = r4(p - mid); out[m.ticker] = { p: r4(p), dev, n: bins.length, kind: "between", sum: r4(sum), flag: Math.abs(dev) >= flagAt }; }
  }
  return out;
}
// All events in a market list → ticker → ladder info.
export function fitAll(markets, opt) {
  const by = {}; for (const m of markets) if (m.strike_type && m.event_ticker) (by[m.event_ticker] ||= []).push(m);
  const out = {}; for (const g of Object.values(by)) if (g.length >= 3) Object.assign(out, fitEvent(g, opt));
  return out;
}
