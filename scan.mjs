// Kalshi feed: pulls ALL open Kalshi events (public data, read-only), keeps only what matters,
// and writes a small bets.json that Agent Flow reads for free. Runs on GitHub Actions — no AI, no cost.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { kalshi, sleep, fee, marketUrl } from "./lib.mjs";
const EVENTS = "/events?status=open&with_nested_markets=true&limit=200";
const MAX_DAYS = 120, MIN_VOL = 50, now = Date.now();
const link = e => marketUrl(e.series_ticker || e.event_ticker);
const days = t => (Date.parse(t) - now) / 864e5;
const r2 = x => Math.round(x * 100) / 100;
// Efficiency: this feed only serves the Agent Flow page; refresh it at most every 25 minutes (FORCE=1 to run anyway).
try { const prev = JSON.parse(readFileSync("bets.json", "utf8")); if (process.env.FORCE !== "1" && now - Date.parse(prev.updated) < 25 * 6e4) { console.log("feed: updated <25 min ago — skipped"); process.exit(0); } } catch {}

let events = [], cursor = "";
for (let p = 0; p < 100; p++) {
  const j = await kalshi(EVENTS + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));   // backs off on 429/5xx
  events.push(...(j.events || [])); cursor = j.cursor;
  if (!cursor) break;
  await sleep(250);
}

const markets = [], sets = [];
for (const e of events) {
  const ms = (e.markets || []).filter(m => m.status === "active" || m.status === "open");
  for (const m of ms) {
    const ya = +m.yes_ask_dollars, yb = +m.yes_bid_dollars || 0, vol = +(m.volume_fp || 0), v24 = +(m.volume_24h_fp || 0);
    if (!(ya > 0 && ya < 1) || vol < MIN_VOL || days(m.close_time) > MAX_DAYS) continue;
    markets.push({ t: (m.title || e.title) + (m.yes_sub_title && ms.length > 1 && !(m.title || "").includes(m.yes_sub_title) ? " — " + m.yes_sub_title : ""),
      pc: Math.round((yb > 0 ? (ya + yb) / 2 : ya) * 100), url: link(e), price: ya, bid: yb, spread: r2(ya - yb), vol: Math.round(vol), v24: Math.round(v24),
      close: m.close_time, cat: e.category || "", rules: (m.rules_primary || "").slice(0, 240), ticker: m.ticker });
  }
  if (e.mutually_exclusive && ms.length > 1 && ms.every(m => +m.yes_ask_dollars > 0)) {
    const cost = ms.reduce((a, m) => a + +m.yes_ask_dollars, 0), fees = ms.reduce((a, m) => a + fee(+m.yes_ask_dollars), 0), profit = 1 - cost - fees;
    const last = Math.max(...ms.map(m => days(m.close_time)));
    // A set only pays for sure if its outcomes cover every result; full sets cost ~ $1, so anything far below is a partial list.
    if (profit >= 0.01 && cost >= 0.9 && last <= MAX_DAYS)
      sets.push({ t: e.title, url: link(e), price: r2(cost), fees: r2(fees), profit: r2(profit), qty: Math.floor(Math.min(...ms.map(m => +(m.yes_ask_size_fp || 0)))),
        close: ms.map(m => m.close_time).sort().pop(), legs: ms.map(m => `${m.yes_sub_title || m.ticker} ${Math.round(+m.yes_ask_dollars * 100)}¢`), cat: e.category || "" });
  }
}
const score = b => b.v24 * 2 + b.vol / 50 - b.spread * 500;
markets.sort((a, b) => score(b) - score(a)); markets.splice(400);
// ---- memory: price history per market (last 48h of snapshots) → momentum & volume signals ----
const hist = existsSync("history.json") ? JSON.parse(readFileSync("history.json", "utf8")) : {};
const keep = now - 48 * 36e5, tNow = Math.round(now / 1000);
const at = (h, hoursAgo) => { const t = tNow - hoursAgo * 3600; let best = null; for (const p of h) if (p[0] <= t + 600) best = p; return best; };
for (const m of markets) {
  const h = (hist[m.ticker] || []).filter(p => p[0] * 1000 >= keep);
  const p1 = at(h, 1), p24 = at(h, 24), v24 = at(h, 24);
  m.chg1h = p1 ? Math.round((m.price - p1[1]) * 100) : null;      // cents moved in ~1h
  m.chg24h = p24 ? Math.round((m.price - p24[1]) * 100) : null;   // cents moved in ~24h
  m.volGrowth = v24 && v24[2] ? Math.round((m.vol - v24[2]) ) : null; // contracts traded since ~24h ago
  h.push([tNow, m.price, m.vol]); hist[m.ticker] = h;
}
for (const k of Object.keys(hist)) { hist[k] = hist[k].filter(p => p[0] * 1000 >= keep); if (!hist[k].length) delete hist[k]; }
writeFileSync("history.json", JSON.stringify(hist));
sets.sort((a, b) => b.profit - a.profit);
let old = {}; try { old = JSON.parse(readFileSync("bets.json", "utf8")); } catch {}
const out = { picks: old.picks || [], picksUpdated: old.picksUpdated, picksAgents: old.picksAgents, feed: "kalshi", updated: new Date().toISOString(), events: events.length, liquid: markets.length, sets: sets.slice(0, 25), markets: markets.slice(0, 150) };
writeFileSync("bets.json", JSON.stringify(out));
console.log(`events ${events.length}, liquid markets ${markets.length}, profit sets ${sets.length}`);
