// Crypto fair-value agent: outside data from Coinbase's public API (free, no key).
// For a Kalshi crypto market ("BTC $83,750 or above at 5pm"), estimate P(YES) from the coin's current price and its recent
// volatility, assuming the price over the time left moves like a random walk with no drift:
//   P(price at close > K) = Φ( ln(S/K) / (σ·√τ) )   with σ = std of 1-minute log returns, τ = minutes to close.
// Approximation: Kalshi settles on CF Benchmarks' index (a 60-second average), not Coinbase spot. Close, not identical.
import { r4, sleep } from "../lib.mjs";

const HOST = "https://api.exchange.coinbase.com";
// HYPE is excluded: Coinbase's HYPE-USD (~$72 on 2026-11-10) is not the asset Kalshi's HYPE markets track (strikes ~$91).
export const product = series => { const m = String(series || "").match(/^KX(BTC|ETH|SOL|XRP|DOGE|BNB)/); return m ? m[1] + "-USD" : null; };

// Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7).
export function Phi(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
const clampP = p => Math.min(0.995, Math.max(0.005, p));

// P(YES) for a strike market. strikeType: "greater" (above floor), "less" (below cap), "between" (floor..cap).
export function fairProb({ spot, sigmaMin, minutes, strikeType, floor, cap }) {
  if (!(spot > 0 && sigmaMin > 0 && minutes > 0)) return null;
  const s = sigmaMin * Math.sqrt(minutes), above = K => Phi(Math.log(spot / K) / s);
  if (strikeType === "greater" && floor > 0) return clampP(above(floor));
  if (strikeType === "less" && (cap ?? floor) > 0) return clampP(1 - above(cap ?? floor));
  if (strikeType === "between" && floor > 0 && cap > floor) return clampP(above(floor) - above(cap));
  return null;
}

// Spot and per-minute volatility from 1-minute candles ending at `endMs` (live: now; backtest: the snapshot time).
export function fromCandles(rows) {
  const c = rows.filter(r => Array.isArray(r) && r[4] > 0).sort((a, b) => a[0] - b[0]);   // [time, low, high, open, close, volume]
  if (c.length < 20) return null;
  const lr = c.slice(1).map((r, i) => Math.log(r[4] / c[i][4])), m = lr.reduce((s, x) => s + x, 0) / lr.length;
  const sd = Math.sqrt(lr.reduce((s, x) => s + (x - m) ** 2, 0) / (lr.length - 1));
  return { spot: c.at(-1)[4], sigmaMin: sd, n: c.length, lastAt: c.at(-1)[0] * 1000 };
}

const cache = new Map();
export async function snapshot(prod, endMs, minutes = 120) {
  const key = prod + "|" + Math.floor(endMs / 6e4);
  if (cache.has(key)) return cache.get(key);
  const iso = ms => new Date(ms).toISOString();
  let out = null;
  for (let a = 0; a < 3 && !out; a++) {
    try {
      const r = await fetch(`${HOST}/products/${prod}/candles?granularity=60&start=${iso(endMs - minutes * 6e4)}&end=${iso(endMs)}`, { headers: { "user-agent": "kalshi-research-agent" } });
      if (r.status === 429) { await sleep(1000 * (a + 1)); continue; }
      if (!r.ok) break;
      out = fromCandles(await r.json());
    } catch { await sleep(1000); }
  }
  if (out) out.at = new Date(endMs).toISOString();
  cache.set(key, out);
  return out;
}

// Estimate for one Kalshi market object at time atMs, or null when this agent doesn't cover it.
export async function estimate(m, atMs, series) {
  const prod = product(series); if (!prod) return null;
  const snap = await snapshot(prod, atMs); if (!snap) return null;
  const minutes = (Date.parse(m.close_time) - atMs) / 6e4;
  const p = fairProb({ spot: snap.spot, sigmaMin: snap.sigmaMin, minutes, strikeType: m.strike_type, floor: +m.floor_strike || null, cap: +m.cap_strike || null });
  // Mismatch guard: an uncertain market (10–90%) answered with near-certainty from a strike far from spot means the outside
  // price probably isn't the asset Kalshi settles on. Skip rather than feed a confident wrong number.
  const mid = (+m.yes_bid_dollars + +m.yes_ask_dollars) / 2, K = +m.floor_strike || +m.cap_strike;
  if (p != null && mid > 0.1 && mid < 0.9 && (p < 0.01 || p > 0.99) && K > 0 && Math.abs(Math.log(snap.spot / K)) > 0.15) {
    console.log(`crypto agent: source mismatch on ${m.ticker} (spot ${snap.spot}, strike ${K}, market ${mid.toFixed(2)}): skipped`); return null;
  }
  return p == null ? null : { p: r4(p), src: "coinbase", product: prod, spot: snap.spot, sigmaMin: r4(snap.sigmaMin * 1e4) / 1e4, minutes: Math.round(minutes), at: snap.at };
}
