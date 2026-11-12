// Weather index agent (rebuilt 2026-11-12). Outside data: US National Weather Service (api.weather.gov, free, no key).
// Kalshi's hourly temperature markets settle on the "Kalshi Weather Index" for a metro area: per the contract terms
// (assets.kalshi.com/contract_terms/<CITY>WINDEX.pdf, Appendix B) it is the equal-weight average of a fixed list of airport
// ASOS stations (one-minute data via Synoptic), each with a small static offset that cancels when all members report,
// published only when ≥ 80% of the weight is available. We approximate it with the same stations' latest NWS observations:
//   nowcast  N = average of member stations' latest temperature (each ≤ 75 min old; needs ≥ 80% of members)
//   estimate F = N + (N − N one hour earlier) × hours left          [the last hour's trend carried forward, capped at ±6°F]
//   P(index > K) = 1 − Φ((K − F) / σ),  σ = max(2.5°F, fitted residual spread) — never below 2.5°F, and P is clamped to 3%…97%.
// The old version read ONE station near the city centre (3–8°F warmer than the index on the logged evenings) with σ ≈ 1.2°F.
import { r4, readJson, sleep } from "../lib.mjs";
import { Phi } from "./crypto.mjs";

const HOST = "https://api.weather.gov", UA = { "user-agent": "kalshi-research-agent", accept: "application/geo+json" };
// Series → member stations (contract terms, read 2026-11-12).
export const INDEX = {
  KXTEMPCHIHS: { city: "Chicago Metro", members: ["KMDW", "KORD", "KPWK", "KDPA", "KARR"] },
  KXTEMPNYCHS: { city: "New York City", members: ["KLGA", "KEWR", "KTEB", "KCDW", "KHPN", "KFRG", "KSMQ", "KISP"] },
  KXTEMPLAXHS: { city: "Coastal Los Angeles", members: ["KHHR", "KLAX", "KSMO", "KLGB", "KSNA"] },
  KXTEMPMIAH: { city: "Miami", members: ["KMIA", "KOPF", "KFLL", "KFXE", "KPMP"] },
};
export const covers = series => series in INDEX;
export const SIGMA_FLOOR = 2.5, CLAMP = 0.97, MAX_AGE_MIN = 75, QUORUM = 0.8;

export function tempProb({ F, sigma, strikeType, floor, cap }) {
  if (!Number.isFinite(F) || !(sigma > 0)) return null;
  const s = Math.max(SIGMA_FLOOR, sigma), below = K => Phi((K - F) / s), clampP = p => Math.min(CLAMP, Math.max(Math.round((1 - CLAMP) * 1e4) / 1e4, p));
  if (strikeType === "greater" && floor != null) return clampP(1 - below(floor));
  if (strikeType === "less" && (cap ?? floor) != null) return clampP(below(cap ?? floor));
  if (strikeType === "between" && floor != null && cap > floor) return clampP(below(cap) - below(floor));
  return null;
}
// Index nowcast at time t from per-station observation lists { station: [[ms, °C], …] } — uses only observations at or before t.
export function nowcast(members, obs, t) {
  const used = [];
  for (const st of members) { const a = (obs[st] || []).filter(x => x[0] <= t && t - x[0] <= MAX_AGE_MIN * 6e4 && Number.isFinite(x[1])).at(-1); if (a) used.push({ st, f: a[1] * 9 / 5 + 32, at: a[0] }); }
  if (used.length < Math.ceil(QUORUM * members.length)) return null;
  return { F: used.reduce((s, x) => s + x.f, 0) / used.length, n: used.length, newest: Math.max(...used.map(x => x.at)), oldest: Math.min(...used.map(x => x.at)) };
}
// Spread of (index at target − estimate): fitted from resolved residuals when there are enough, never below the floor.
export function sigmaFor(leadHours, fitted = null) { return Math.max(SIGMA_FLOOR, fitted?.n >= 30 ? fitted.sd : 1.5 + 1.0 * Math.max(0, leadHours)); }

async function getJson(url) {
  for (let a = 0; a < 3; a++) {
    try { const r = await fetch(url, { headers: UA }); if (r.ok) return r.json(); if (r.status >= 500 || r.status === 429) { await sleep(1500 * (a + 1)); continue; } return null; } catch { await sleep(1500); }
  }
  return null;
}
const cache = new Map();
async function cached(key, ttlMs, fn) { const c = cache.get(key); if (c && Date.now() - c.at < ttlMs) return c.v; const v = await fn(); cache.set(key, { at: Date.now(), v }); return v; }
export const stationObs = st => cached("o:" + st, 4 * 6e4, async () => { const j = await getJson(`${HOST}/stations/${st}/observations?limit=40`);
  return (j?.features || []).map(f => [Date.parse(f.properties.timestamp), f.properties.temperature?.value]).filter(x => Number.isFinite(x[0]) && x[1] != null).sort((a, b) => a[0] - b[0]); });
// Trend-carried estimate at time t for a target time, from observation lists (pure: used live and by the regression test).
export function indexEstimate(members, obs, t, target) {
  const now = nowcast(members, obs, t); if (!now) return null;
  const prev = nowcast(members, obs, t - 36e5), lead = (target - t) / 36e5, drift = prev ? Math.max(-6, Math.min(6, (now.F - prev.F) * Math.max(0, lead))) : 0;
  return { F: now.F + drift, nowcastF: now.F, drift, lead, now };
}
export async function estimate(m, atMs, series, fitted = readJson("state/weather-fit.json", null)) {
  if (!covers(series)) return null;
  const I = INDEX[series], obs = {}; for (const st of I.members) obs[st] = await stationObs(st);
  const e = indexEstimate(I.members, obs, atMs, Date.parse(m.close_time)); if (!e) return null;
  const sigma = sigmaFor(e.lead, fitted);
  const p = tempProb({ F: e.F, sigma, strikeType: m.strike_type, floor: m.floor_strike == null ? null : +m.floor_strike, cap: m.cap_strike == null ? null : +m.cap_strike });
  return p == null ? null : { p: r4(p), src: "nws-index", city: I.city, estimateF: r4(e.F), nowcastF: r4(e.nowcastF), driftF: r4(e.drift), stations: e.now.n, of: I.members.length, sigmaF: r4(sigma), leadH: r4(e.lead),
    obsNewest: new Date(e.now.newest).toISOString(), obsOldest: new Date(e.now.oldest).toISOString(), at: new Date().toISOString() };
}
