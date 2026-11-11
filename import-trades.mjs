// Import YOUR Kalshi trade history from a CSV you export yourself (Kalshi website → account history / documents).
// Output stays in private/ (git-ignored: this repo is public).
//   node import-trades.mjs [private/kalshi-trades.csv]   from a CSV you export (no key)
//   node import-trades.mjs --api                          from your fills via your read-only key in private/ (kalshi-auth.mjs)
// Columns are matched by name; the report lists anything it couldn't map so the aliases below can be extended.
import { readFileSync, existsSync } from "node:fs";
import { kalshi, sleep, fee, r4, writeJson, readJson } from "./lib.mjs";
import { loadSamples, makeRecall } from "./memory.mjs";

const ALIASES = {
  ticker: ["ticker", "market_ticker", "market ticker", "market", "contract", "symbol"],
  side: ["side", "direction", "position", "outcome", "contract side"],
  action: ["action", "type", "order type", "trade type", "buy/sell"],
  price: ["price", "avg_price", "average price", "avg price", "fill price", "price (cents)", "yes_price", "entry price", "cost per contract"],
  count: ["count", "contracts", "quantity", "qty", "filled", "size", "shares"],
  fees: ["fees", "fee", "trading fees", "total fees"],
  time: ["created_time", "created", "date", "time", "timestamp", "filled at", "trade date", "executed at"],
};

export function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some(x => x !== "")) rows.push(row); row = []; }
    else f += ch;
  }
  row.push(f); if (row.some(x => x !== "")) rows.push(row);
  return rows;
}

export function mapColumns(header) {
  const h = header.map(x => x.trim().toLowerCase()), map = {};
  for (const [k, names] of Object.entries(ALIASES)) { const i = h.findIndex(x => names.includes(x)); if (i >= 0) map[k] = i; }
  return { map, unmapped: header.filter((_, i) => !Object.values(map).includes(i)) };
}

// One normalized trade, or null if it can't be scored. Price is the price paid for the chosen side, in dollars.
export function normalize(cells, map) {
  const g = k => map[k] == null ? "" : String(cells[map[k]] ?? "").trim();
  const ticker = g("ticker").toUpperCase(), sideRaw = (g("side") + " " + g("action")).toLowerCase();
  const side = /\bno\b/.test(sideRaw) ? "no" : /\byes\b/.test(sideRaw) ? "yes" : null;
  const sell = /\bsell|\bclose/.test(sideRaw);
  let price = parseFloat(g("price").replace(/[$¢,]/g, "")); if (price > 1) price /= 100;
  const count = parseFloat(g("count").replace(/,/g, "")) || 1, fees = g("fees") === "" ? null : Math.abs(parseFloat(g("fees").replace(/[$,]/g, "")));
  if (!ticker || !side || !(price > 0 && price < 1)) return null;
  return { ticker, side, sell, price: r4(price), count, fees, time: g("time") || null };
}

// One fill from GET /portfolio/fills → the same shape as normalize(). Price = price paid for the chosen side, in dollars.
export function fromFill(f) {
  const side = f.side === "no" ? "no" : f.side === "yes" ? "yes" : null;
  let price = +(side === "no" ? f.no_price_dollars ?? f.no_price : f.yes_price_dollars ?? f.yes_price); if (price > 1) price /= 100;
  if (!f.ticker || !side || !(price > 0 && price < 1)) return null;
  return { ticker: String(f.ticker).toUpperCase(), side, sell: f.action === "sell", price: r4(price), count: +(f.count_fp ?? f.count) || 1, fees: null, time: f.created_time || null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const api = process.argv.includes("--api");
  let file, lines, unmapped = [], trades;
  if (api) {                                                                   // read-only key, owner's computer only
    const { keyedGet, hasKey } = await import("./kalshi-auth.mjs");
    if (!hasKey()) { console.log("No key files in private/ (kalshi-key-id.txt + kalshi-key.pem). See docs/manual.md → Kalshi key."); process.exit(0); }
    lines = []; let cursor = "";
    do { const j = await keyedGet(`/portfolio/fills?limit=200${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`); lines.push(...(j.fills || [])); cursor = j.cursor; await sleep(200); } while (cursor);
    file = "api: /portfolio/fills"; trades = lines.map(fromFill);
  } else {
    file = process.argv[2] || "private/kalshi-trades.csv";
    if (!existsSync(file)) { console.log(`No file at ${file}. Export your trade history from Kalshi as CSV and save it there (private/ is git-ignored), or use --api with your key.`); process.exit(0); }
    const [header, ...rows] = parseCsv(readFileSync(file, "utf8")); lines = rows;
    const mc = mapColumns(header), map = mc.map; unmapped = mc.unmapped;
    const missing = ["ticker", "side", "price"].filter(k => map[k] == null);
    if (missing.length) { console.log(`Can't find column(s): ${missing.join(", ")}. Header: ${header.join(" | ")}. Add the names to ALIASES in import-trades.mjs.`); process.exit(1); }
    trades = lines.map(c => normalize(c, map));
  }
  const bad = trades.filter(t => !t).length, ok = trades.filter(Boolean);

  // Official outcomes for every ticker (public API, 200 per call).
  const tickers = [...new Set(ok.map(t => t.ticker))], res = {};
  for (let i = 0; i < tickers.length; i += 200) {
    const j = await kalshi(`/markets?limit=1000&tickers=${tickers.slice(i, i + 200).map(encodeURIComponent).join(",")}`);
    for (const m of j.markets || []) res[m.ticker] = { result: m.result, series: String(m.event_ticker).split("-")[0], title: m.title };
    await sleep(250);
  }
  const cats = readJson("data/series.json", { map: {} }).map, recall = makeRecall(loadSamples());
  const scored = [], open = [];
  for (const t of ok) {
    const r = res[t.ticker];
    if (t.sell) continue; // sells close positions; v1 scores buys held to settlement
    if (!r || (r.result !== "yes" && r.result !== "no")) { open.push(t); continue; }
    const win = (r.result === t.side) ? 1 : 0, f = t.fees ?? fee(t.price) * t.count;
    scored.push({ ...t, series: r.series, cat: cats[r.series] || "", title: r.title, win, pnl: r4(t.count * (win - t.price) - f), memory: recall(r.series) });
  }
  const sum = a => a.reduce((s, x) => s + x, 0), group = k => {
    const o = {};
    for (const t of scored) { const g = (o[t[k] || "?"] ||= { n: 0, wins: 0, avgPrice: 0, pnl: 0 }); g.n++; g.wins += t.win; g.avgPrice += t.price; g.pnl += t.pnl; }
    for (const g of Object.values(o)) { g.winRate = r4(g.wins / g.n); g.avgPrice = r4(g.avgPrice / g.n); g.edge = r4(g.winRate - g.avgPrice); g.pnl = r4(g.pnl); }
    return o;
  };
  const report = {
    updated: new Date().toISOString(), file, rows: lines.length, unparsed: bad, sells: ok.filter(t => t.sell).length, open: open.length,
    scored: scored.length, wins: sum(scored.map(t => t.win)), pnl: r4(sum(scored.map(t => t.pnl))),
    avgPricePaid: scored.length ? r4(sum(scored.map(t => t.price)) / scored.length) : null,
    winRate: scored.length ? r4(sum(scored.map(t => t.win)) / scored.length) : null,
    note: "edge = win rate − average price paid. Below 0 = you paid more than outcomes justified. Few trades = noisy; no conclusions under ~100.",
    byCategory: group("cat"), bySeries: group("series"), unmappedColumns: unmapped, trades: scored,
  };
  writeJson("private/my-trades-report.json", report);
  console.log(`your trades: ${report.scored} settled buys scored (${report.open} open, ${report.sells} sells skipped, ${bad} unreadable rows); ` +
    `win rate ${report.winRate} vs avg price ${report.avgPricePaid}; P&L ${report.pnl} → private/my-trades-report.json`);
}
