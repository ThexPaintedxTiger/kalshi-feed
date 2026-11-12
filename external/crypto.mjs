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

// Settlement reference. Kalshi's crypto markets settle on CF Benchmarks real-time indices (BRTI for BTC, <COIN>USD_RTI
// otherwise). The live daemon receives those values on Kalshi's own `cfbenchmarks_value` stream (needs the read-only key)
// and registers a lookup here. Without it (cloud, or stream down) the spot is the MEDIAN of several exchanges' last
// prices, which tracks a multi-exchange index more closely than Coinbase alone.
export const indexId = prod => { const c = String(prod || "").split("-")[0]; return c === "BTC" ? "BRTI" : c ? `${c}USD_RTI` : null; };
let refLookup = null;
export const setReference = fn => { refLookup = fn; };
const PAIRS = { "BTC-USD": ["XBTUSD", "btcusd"], "ETH-USD": ["ETHUSD", "ethusd"], "SOL-USD": ["SOLUSD", "solusd"], "XRP-USD": ["XRPUSD", "xrpusd"], "DOGE-USD": ["XDGUSD", "dogeusd"] };
const quick = async (url, pick) => { try { const c = new AbortController(), t = setTimeout(() => c.abort(), 4000), r = await fetch(url, { signal: c.signal, headers: { "user-agent": "kalshi-research-agent" } }); clearTimeout(t); if (!r.ok) return null; const v = +pick(await r.json()); return v > 0 ? v : null; } catch { return null; } };
export const median = a => { const s = a.filter(x => x > 0).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
// Best available spot right now: { spot, src, n }. `coinbase` = the candle-based spot already fetched.
export async function referenceSpot(prod, coinbase, now = Date.now()) {
  const ref = refLookup?.(indexId(prod));
  if (ref && now - ref.at <= 15e3 && ref.value > 0) return { spot: ref.value, src: "cf-benchmarks (Kalshi stream)", n: 1 };
  const p = PAIRS[prod]; if (!p) return { spot: coinbase, src: "coinbase", n: 1 };
  const [kr, bs] = await Promise.all([quick(`https://api.kraken.com/0/public/Ticker?pair=${p[0]}`, j => Object.values(j.result || {})[0]?.c?.[0]), quick(`https://www.bitstamp.net/api/v2/ticker/${p[1]}/`, j => j.last)]);
  const all = [coinbase, kr, bs].filter(x => x > 0 && Math.abs(x / coinbase - 1) < 0.02);            // drop a venue that is > 2% off (stale or wrong asset)
  return all.length >= 2 ? { spot: median(all), src: "median of " + all.length + " exchanges", n: all.length } : { spot: coinbase, src: "coinbase", n: 1 };
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
  const snap0 = await snapshot(prod, atMs); if (!snap0) return null;
  const snap = { ...snap0 };
  const minutes = (Date.parse(m.close_time) - atMs) / 6e4;
  // Live estimates use the settlement reference (or the multi-exchange median); backtests keep the historical Coinbase candle.
  const live = Math.abs(Date.now() - atMs) < 120e3, ref = live ? await referenceSpot(prod, snap.spot) : { spot: snap.spot, src: "coinbase", n: 1 };
  snap.spot = ref.spot;
  const p = fairProb({ spot: snap.spot, sigmaMin: snap.sigmaMin, minutes, strikeType: m.strike_type, floor: +m.floor_strike || null, cap: +m.cap_strike || null });
  // Mismatch guard: an uncertain market (10–90%) answered with near-certainty from a strike far from spot means the outside
  // price probably isn't the asset Kalshi settles on. Skip rather than feed a confident wrong number.
  const mid = (+m.yes_bid_dollars + +m.yes_ask_dollars) / 2, K = +m.floor_strike || +m.cap_strike;
  if (p != null && mid > 0.1 && mid < 0.9 && (p < 0.01 || p > 0.99) && K > 0 && Math.abs(Math.log(snap.spot / K)) > 0.15) {
    console.log(`crypto agent: source mismatch on ${m.ticker} (spot ${snap.spot}, strike ${K}, market ${mid.toFixed(2)}): skipped`); return null;
  }
  return p == null ? null : { p: r4(p), src: ref.src, venues: ref.n, product: prod, spot: snap.spot, sigmaMin: r4(snap.sigmaMin * 1e4) / 1e4, minutes: Math.round(minutes), at: snap.at };
}
