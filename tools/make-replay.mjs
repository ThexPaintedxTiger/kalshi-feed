// Builds the replay fixture from PUBLIC Kalshi data (no key): for a few open, active markets it takes the current order
// book and the last ~40 minutes of real trades and writes them as stream-format messages with their real timestamps.
// A real recording from the owner's daemon (RECORD_RAW=1 → local/raw/) can replace it: same format.
//   node tools/make-replay.mjs        → tests/fixtures/replay.jsonl.gz + replay.expected.json
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { kalshi, sleep, resolvesAt, series } from "../lib.mjs";
import { replay, digest } from "../live/replay.mjs";

const now = Date.now(), nowS = Math.floor(now / 1000), start = now - 40 * 6e4;
const j = await kalshi(`/markets?status=open&limit=1000&mve_filter=exclude&min_close_ts=${nowS + 1800}&max_close_ts=${nowS + 4 * 3600}`);
const pick = (j.markets || []).filter(m => +m.yes_bid_dollars > 0.1 && +m.yes_ask_dollars < 0.9 && +m.volume_24h_fp > 300).sort((a, b) => +b.volume_24h_fp - +a.volume_24h_fp).slice(0, 8);
const rows = [{ t: start, m: { type: "_state", live: true } }], scope = [];
let seq = 0;
for (const m of pick) {
  const t = encodeURIComponent(m.ticker), ob = (await kalshi(`/markets/${t}/orderbook?depth=10`)).orderbook_fp || {};
  const tr = (await kalshi(`/markets/trades?ticker=${t}&min_ts=${Math.floor(start / 1000)}&limit=1000`)).trades || [];
  scope.push({ ticker: m.ticker, event: m.event_ticker, series: series(m), cat: "", title: m.title, resolvesAt: resolvesAt(m), logged: true, loggedAt: start, mid0: (+m.yes_bid_dollars + +m.yes_ask_dollars) / 2 });
  rows.push({ t: start + 500 + scope.length, m: { type: "orderbook_snapshot", sid: 1, seq: ++seq, msg: { market_ticker: m.ticker, yes_dollars_fp: ob.yes_dollars || [], no_dollars_fp: ob.no_dollars || [] } } });
  for (const x of tr) rows.push({ t: Date.parse(x.created_time), m: { type: "trade", sid: 2, msg: { market_ticker: m.ticker, yes_price_dollars: x.yes_price_dollars, count_fp: x.count_fp, taker_side: x.taker_side, taker_outcome_side: x.taker_outcome_side, taker_book_side: x.taker_book_side, is_block_trade: !!x.is_block_trade, ts_ms: Date.parse(x.created_time) } } });
  // A trade moves the quote: after each trade, the ticker channel reports a bid/ask around the trade price (1¢ each side).
  for (const x of tr) { const p = +x.yes_price_dollars; rows.push({ t: Date.parse(x.created_time) + 1, m: { type: "ticker", sid: 3, msg: { market_ticker: m.ticker, yes_bid_dollars: Math.max(0.01, p - 0.01).toFixed(4), yes_ask_dollars: Math.min(0.99, p + 0.01).toFixed(4), price_dollars: p.toFixed(4) } } }); }
  await sleep(150);
}
rows.sort((a, b) => a.t - b.t);
rows.splice(1, 0, { t: start, m: { type: "_scope", list: scope } });
// Mid-way the stream drops for 3 minutes and comes back with fresh snapshots (gap handling must be deterministic too).
const mid = start + 20 * 6e4; rows.push({ t: mid, m: { type: "_state", live: false } }, { t: mid + 180e3, m: { type: "_state", live: true } }); rows.sort((a, b) => a.t - b.t);
const out = replay(rows, { cfg: { updateMove: 0.02, updateEveryMin: 10, updateMinGapSec: 60 } });
writeFileSync("tests/fixtures/replay.jsonl.gz", gzipSync(rows.map(r => JSON.stringify(r)).join("\n") + "\n", { level: 9 }));
writeFileSync("tests/fixtures/replay.expected.json", JSON.stringify({ made: new Date(now).toISOString(), markets: scope.length, messages: rows.length, cfg: { updateMove: 0.02, updateEveryMin: 10, updateMinGapSec: 60 },
  counts: { ticks: out.ticks, features: out.features.length, snaps: out.snaps.length, updates: out.updates.length }, digest: digest(out), updates: out.updates, snaps: out.snaps }, null, 1) + "\n");
console.log(`fixture: ${scope.length} markets, ${rows.length} messages → ${out.features.length} feature rows, ${out.snaps.length} snapshots, ${out.updates.length} re-estimates, digest ${digest(out)}`);
