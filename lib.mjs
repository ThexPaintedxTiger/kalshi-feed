// Shared helpers for the research pipeline (predict → resolve → score). No AI, no keys, public data only.
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

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
export const marketUrl = s => "https://kalshi.com/markets/" + String(s || "").toLowerCase();
export const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
export const LOG_KINDS = ["predictions", "backtest", "snapshots"];                    // month-file logs (hot + archive)
export const clip = (p, e = 0.01) => Math.min(1 - e, Math.max(e, p));
export const r4 = x => Math.round(x * 1e4) / 1e4;

// Append-only JSONL storage. Archived months are gzipped (.jsonl.gz) and read the same way.
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const b = readFileSync(file);
  return (file.endsWith(".gz") ? gunzipSync(b) : b).toString("utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}
export function appendJsonl(file, rows) {
  if (!rows.length) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
}
export function writeJson(file, obj) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(obj, null, 1) + "\n"); }
export function readJson(file, dflt) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return dflt; } }

// Storage tiers. Hot: data/<kind>/YYYY-MM.jsonl (appended to). Archive: data/archive/<kind>/YYYY-MM[.partN].jsonl.gz
// (moved there by archive.mjs, verified, never edited). kind = predictions | backtest | snapshots.
export const MONTH_FILE = /^(\d{4}-\d{2})(?:\.part(\d+))?\.jsonl(?:\.gz)?$/;
const ymOf = d => d.toISOString().slice(0, 7);
export const hotFile = (kind, now = new Date()) => `data/${kind}/${ymOf(now)}.jsonl`;
// Every file of a kind, oldest month first (archived parts before the hot file). `months` limits to those YYYY-MM.
export function allMonthFiles(kind, months = null, root = ".") {
  const out = [], arch = new Set();
  for (const [d, tier] of [[`data/archive/${kind}`, 0], [`data/${kind}`, 1]]) {
    const dir = root === "." ? d : `${root}/${d}`;
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(MONTH_FILE); if (!m || (months && !months.includes(m[1]))) continue;
      if (tier === 0) arch.add(f.replace(/\.gz$/, ""));
      else if (arch.has(f)) continue;                                   // archived copy verified identical; hot copy left by an interrupted move
      out.push({ path: `${d}/${f}`, ym: m[1], tier, part: m[2] ? +m[2] : 0 });
    }
  }
  return out.sort((a, b) => a.ym.localeCompare(b.ym) || a.tier - b.tier || a.part - b.part).map(x => x.path);
}
// This month's and last month's prediction files (hot + any archived parts): enough for de-duplication and resolving.
// Every row of a month-file log (hot + archive), oldest first.
export const readLog = kind => allMonthFiles(kind).flatMap(f => readJsonl(f));
// One prediction per market: the first logged row counts. A later row for the same ticker (two runs overlapping) is
// ignored by every reader; the log itself is never edited. The watchdog reports how many were ignored.
export function firstPerTicker(rows) { const seen = new Set(); return rows.filter(r => !seen.has(r.ticker) && seen.add(r.ticker)); }
export const predictionRows = () => firstPerTicker(readLog("predictions"));

export function predictionFiles(now = new Date()) {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return allMonthFiles("predictions", [ymOf(prev), ymOf(now)]);
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

// FNV-1a hash: a fixed order that can't depend on outcomes (used to pick backtest markets within an event).
export const hash = t => { let h = 2166136261; for (const ch of String(t)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
