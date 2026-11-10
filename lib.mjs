// Shared helpers for the research pipeline (predict → resolve → score). No AI, no keys, public data only.
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const API = "https://api.elections.kalshi.com/trade-api/v2";
export const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// GET JSON from the public Kalshi API, backing off on 429 (rate limit) and 5xx.
export async function kalshi(path) {
  for (let a = 0; a < 6; a++) {
    let r;
    try { r = await fetch(API + path, { headers: { accept: "application/json" } }); }
    catch (e) { await sleep(2000 * (a + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (a + 1)); continue; }
    if (!r.ok) throw new Error(`Kalshi HTTP ${r.status} for ${path.split("?")[0]}`);
    return r.json();
  }
  throw new Error(`Kalshi kept failing for ${path.split("?")[0]}`);
}

// Kalshi taker fee per contract, in dollars: ceil(0.07 × P × (1−P)) rounded up to the cent.
export const fee = p => Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100;

// Expected value per $1 contract after fees, for a probability p and the prices you'd actually pay.
// YES is bought at the ask; NO is bought at 1 − (yes bid).
export function ev(p, ask, bid) {
  const noCost = 1 - bid;
  return { yes: p - ask - fee(ask), no: (1 - p) - noCost - fee(noCost) };
}

// When a market really resolves. Sports markets keep close_time ~2 weeks after the game,
// so the earlier of close_time and expected_expiration_time is the honest answer.
export function resolvesAt(m) {
  const t = [m.close_time, m.expected_expiration_time].map(s => Date.parse(s)).filter(Number.isFinite);
  return t.length ? new Date(Math.min(...t)).toISOString() : null;
}

export const series = m => String(m.event_ticker || m.ticker || "").split("-")[0];
export const clip = (p, e = 0.01) => Math.min(1 - e, Math.max(e, p));
export const r4 = x => Math.round(x * 1e4) / 1e4;

// Append-only JSONL storage.
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}
export function appendJsonl(file, rows) {
  if (!rows.length) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
}
export function writeJson(file, obj) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(obj, null, 1) + "\n"); }
export function readJson(file, dflt) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return dflt; } }

// One predictions file per month keeps files small; returns this month's and last month's paths.
export function predictionFiles(now = new Date()) {
  const ym = d => d.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [`data/predictions/${ym(prev)}.jsonl`, `data/predictions/${ym(now)}.jsonl`];
}

// Series → Kalshi category, cached in data/series.json; unknown series are looked up one by one (≤ limit per call).
export async function categories(seriesList, limit = 30) {
  const cats = readJson("data/series.json", { map: {} });
  for (const t of [...new Set(seriesList)].filter(t => t && !(t in cats.map)).slice(0, limit)) {
    try { cats.map[t] = (await kalshi(`/series/${encodeURIComponent(t)}`)).series?.category || ""; await sleep(150); }
    catch (e) { console.log(`series ${t}: ${e.message}`); }
  }
  writeJson("data/series.json", cats);
  return cats.map;
}
