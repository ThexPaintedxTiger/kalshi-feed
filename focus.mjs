// Focus markets: live price action for the markets the agent is watching right now (open live predictions, the ones
// a strategy would paper-bet first, then the soonest to resolve). One batch call for the last 3 hours of 1-minute
// candles. Feeds the Trading tab's ticker tape and price chart. Free; no AI.
import { config, kalshi, readJsonl, writeJson, r4 } from "./lib.mjs";
import { allPredictions } from "./memory.mjs";

const now = Date.now(), nowS = Math.floor(now / 1000);
const done = new Set(readJsonl("data/outcomes.jsonl").map(o => o.ticker));
const excluded = new Set(config.scan.excludeCategories || []);
const open = allPredictions().filter(p => p.cfg >= 4 && !excluded.has(p.cat) && Date.parse(p.resolvesAt) > now + 5 * 60e3 && !done.has(p.ticker))
  .sort((a, b) => (Object.keys(b.picks || {}).length - Object.keys(a.picks || {}).length) || (Date.parse(a.resolvesAt) - Date.parse(b.resolvesAt)));
const seen = new Set(), pick = [];
for (const p of open) { if (seen.has(p.event)) continue; seen.add(p.event); pick.push(p); if (pick.length >= 12) break; }   // one per event, 12 max

const out = { updated: new Date(now).toISOString(), markets: [] };
if (pick.length) {
  try {
    const j = await kalshi(`/markets/candlesticks?market_tickers=${pick.map(p => encodeURIComponent(p.ticker)).join(",")}&start_ts=${nowS - 3 * 3600}&end_ts=${nowS}&period_interval=1`);
    const by = Object.fromEntries((j.markets || []).map(m => [m.market_ticker, m.candlesticks || []]));
    for (const p of pick) {
      const pts = (by[p.ticker] || []).filter(c => c.yes_bid?.close_dollars != null && c.yes_ask?.close_dollars != null)
        .map(c => [c.end_period_ts * 1000, r4((+c.yes_bid.close_dollars + +c.yes_ask.close_dollars) / 2), +(c.volume_fp || 0)]);
      const last = pts.at(-1), at = ms => [...pts].reverse().find(x => x[0] <= now - ms);
      const m30 = at(30 * 6e4), m3h = pts[0];
      out.markets.push({ ticker: p.ticker, title: p.title, cat: p.cat, resolvesAt: p.resolvesAt, loggedPrice: p.mid, est: p.est, picks: p.picks,
        price: last ? last[1] : null, chg30m: last && m30 ? r4(last[1] - m30[1]) : null, chg3h: last && m3h ? r4(last[1] - m3h[1]) : null,
        series: pts.length > 180 ? pts.filter((_, i) => i % Math.ceil(pts.length / 180) === 0) : pts,
        url: "https://kalshi.com/markets/" + String(p.series || "").toLowerCase() });
    }
  } catch (e) { out.error = e.message; }
}
writeJson("data/focus.json", out);
console.log(`focus: ${out.markets.length} markets with live prices${out.error ? " (error: " + out.error + ")" : ""}`);
