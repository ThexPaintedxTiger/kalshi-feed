// Weather forecast agent: outside data from the US National Weather Service (api.weather.gov, free, no key).
// Kalshi's hourly temperature markets ("temp in Miami above 83.99° at 6pm EST") settle on Synoptic Data readings for a city.
// We take NWS's hourly forecast temperature F for that city at that hour and treat the forecast error as normal:
//   F = latest observed temperature at the nearest NWS station + the forecast's change from now to the target hour
//       (forecast only, if no observation in the last 90 min),
//   P(temp > K) = 1 − Φ((K − F) / σ),  σ = 1°F + 0.3°F per hour of lead time with an observation (2°F + 0.15°F/h without), capped at 5°F.
// Live only: NWS doesn't publish past forecasts, so this predictor is scored going forward.
import { r4, readJson, writeJson, sleep } from "../lib.mjs";
import { Phi } from "./crypto.mjs";

const HOST = "https://api.weather.gov", UA = { "user-agent": "kalshi-research-agent", accept: "application/geo+json" };
// Series → [lat, lon, label]. City-center points; Kalshi's "metro area" readings come from nearby stations, so this is an approximation.
export const CITY = {
  KXTEMPMIAH: [25.7617, -80.1918, "Miami"],
  KXTEMPLAXHS: [33.9425, -118.4081, "Coastal Los Angeles"],
  KXTEMPCHIHS: [41.8781, -87.6298, "Chicago"],
  KXTEMPNYCHS: [40.7128, -74.0060, "New York City"],
};
export const covers = series => series in CITY;

export function tempProb({ F, sigma, strikeType, floor, cap }) {
  if (!Number.isFinite(F) || !(sigma > 0)) return null;
  const below = K => Phi((K - F) / sigma), clampP = p => Math.min(0.995, Math.max(0.005, p));
  if (strikeType === "greater" && floor != null) return clampP(1 - below(floor));
  if (strikeType === "less" && (cap ?? floor) != null) return clampP(below(cap ?? floor));
  if (strikeType === "between" && floor != null && cap > floor) return clampP(below(cap) - below(floor));
  return null;
}
export const sigmaFor = (leadHours, observed = false) => Math.min(5, observed ? 1 + 0.3 * Math.max(0, leadHours) : 2 + 0.15 * Math.max(0, leadHours));

const GRID = "data/external/nws-grid.json", forecasts = new Map();
async function getJson(url) {
  for (let a = 0; a < 3; a++) {
    try { const r = await fetch(url, { headers: UA }); if (r.ok) return r.json(); if (r.status >= 500 || r.status === 429) { await sleep(1500 * (a + 1)); continue; } return null; }
    catch { await sleep(1500); }
  }
  return null;
}
// Hourly forecast periods for a series' city (one /points lookup per city, cached on disk; one forecast call per city per run).
export async function hourly(series) {
  if (forecasts.has(series)) return forecasts.get(series);
  const [lat, lon] = CITY[series], grid = readJson(GRID, {});
  let g = grid[series];
  if (!g?.forecast) {
    const p = await getJson(`${HOST}/points/${lat},${lon}`);
    const st = p?.properties?.observationStations ? await getJson(p.properties.observationStations) : null;
    g = { forecast: p?.properties?.forecastHourly || null, station: st?.features?.[0]?.properties?.stationIdentifier || null };
    if (g.forecast) { grid[series] = g; writeJson(GRID, grid); }
  }
  const f = g?.forecast ? await getJson(g.forecast) : null;
  const ob = g?.station ? await getJson(`${HOST}/stations/${g.station}/observations/latest`) : null;
  const oc = ob?.properties?.temperature?.value, obsAt = Date.parse(ob?.properties?.timestamp || "");
  const observed = Number.isFinite(oc) && Date.now() - obsAt < 90 * 6e4 ? { tempF: Math.round((oc * 9 / 5 + 32) * 10) / 10, at: new Date(obsAt).toISOString(), station: g.station } : null;
  const periods = (f?.properties?.periods || []).map(p => ({ start: Date.parse(p.startTime), end: Date.parse(p.endTime), temp: p.temperatureUnit === "C" ? p.temperature * 9 / 5 + 32 : p.temperature }));
  const out = periods.length ? { periods, observed, fetched: new Date().toISOString(), updated: f?.properties?.updateTime || null } : null;
  forecasts.set(series, out);
  return out;
}

export async function estimate(m, atMs, series) {
  if (!covers(series)) return null;
  const fc = await hourly(series); if (!fc) return null;
  const target = Date.parse(m.close_time), per = fc.periods.find(p => p.start <= target && target < p.end);
  if (!per) return null;
  const lead = (target - atMs) / 36e5, nowPer = fc.periods.find(p => p.start <= atMs && atMs < p.end), obs = fc.observed;
  const F = obs && nowPer ? obs.tempF + (per.temp - nowPer.temp) : per.temp, sigma = sigmaFor(lead, !!(obs && nowPer));
  const p = tempProb({ F, sigma, strikeType: m.strike_type, floor: m.floor_strike == null ? null : +m.floor_strike, cap: m.cap_strike == null ? null : +m.cap_strike });
  return p == null ? null : { p: r4(p), src: "nws", city: CITY[series][2], estimateF: r4(F), forecastF: per.temp, observedF: obs?.tempF ?? null, station: obs?.station ?? null, sigmaF: r4(sigma), leadH: r4(lead), at: fc.fetched, nwsUpdated: fc.updated };
}
