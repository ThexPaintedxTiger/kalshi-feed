// Backtest agent: rebuilds "what would we have predicted" for markets that ALREADY settled, using Kalshi's public
// price history. For each settled market it takes the bid/ask from 1-minute candles ending `leadMinutes` before the
// market resolved, runs the same predictors as the live pipeline, and stores the result next to the official outcome.
// Kept separate from the live record (data/backtest/, backtest-scorecard.json): a backtest supports, never replaces, live evidence.
import { config, kalshi, sleep, series, r4, readJson, writeJson, appendJsonl, categories, hash } from "./lib.mjs";
import { estimate } from "./predictors.mjs";
import { loadSamples, makeRecall, backtestRows } from "./memory.mjs";
import { score } from "./score.mjs";

const B = { ...config.backtest, ...(process.env.BT_CALLS ? { maxCandleCalls: +process.env.BT_CALLS, maxPerRun: +process.env.BT_CALLS } : {}) }, S = config.scan, now = Date.now();
const STATE = "data/backtest/state.json";
const state = readJson(STATE, { newest: 0, oldest: 0, lastRun: 0 });
if (process.env.FORCE !== "1" && now - state.lastRun < B.everyMinutes * 6e4) {
  console.log(`backtest: ran ${Math.round((now - state.lastRun) / 6e4)} min ago, next in ≤${B.everyMinutes} min — skipped`); process.exit(0);
}

const end = now - B.settleDelayHours * 36e5, floor = now - B.days * 864e5, slice = B.sliceHours * 36e5;
// Slices of close time to process: forward from the newest done up to `end`, then backward from the oldest done to `floor`.
const slices = [];
if (!state.newest) { state.newest = state.oldest = end; }
for (let a = state.newest; a < end; a += slice) slices.push([a, Math.min(a + slice, end), "fwd"]);
for (let b = state.oldest; b > floor; b -= slice) slices.push([Math.max(b - slice, floor), b, "back"]);

const done = new Set(backtestRows().map(r => r.ticker));
const recall = makeRecall(loadSamples());
const rows = []; let calls = 0, listed = 0, rejected = {};
const skip = why => { rejected[why] = (rejected[why] || 0) + 1; };


// Price snapshot at time T from 1-minute candles: last candle that ended at or before T with both bid and ask.
async function snapshot(m, T) {
  const t = Math.floor(T / 1000);
  calls++;
  const j = await kalshi(`/series/${series(m)}/markets/${encodeURIComponent(m.ticker)}/candlesticks?start_ts=${t - 3600}&end_ts=${t}&period_interval=1`);
  const c = (j.candlesticks || []).filter(x => x.end_period_ts <= t && x.yes_bid?.close_dollars != null && x.yes_ask?.close_dollars != null).pop();
  return c ? { bid: +c.yes_bid.close_dollars, ask: +c.yes_ask.close_dollars, at: c.end_period_ts * 1000 } : null;
}

outer:
for (const [a, b, dir] of slices) {
  const ms = []; let cursor = "", pages = 0;
  do {
    const j = await kalshi(`/markets?status=settled&limit=1000&mve_filter=exclude&min_close_ts=${Math.floor(a / 1000)}&max_close_ts=${Math.floor(b / 1000)}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    ms.push(...(j.markets || [])); cursor = j.cursor; pages++; await sleep(250);
  } while (cursor && pages < 30);
  listed += ms.length;
  // Pick markets WITHOUT using anything that depends on the outcome: liquidity is judged per event (largest market),
  // and the market tried first within an event is chosen by a fixed hash of its ticker (not by its own final volume,
  // which grows on the eventual winner and leaked the result in the first version).
  const byEvent = {};
  for (const m of ms) if (m.result === "yes" || m.result === "no") (byEvent[m.event_ticker] ||= []).push(m);
  let complete = true;
  for (const group of Object.values(byEvent)) {
    if (group.some(m => done.has(m.ticker)) || Math.max(...group.map(m => +(m.volume_fp || 0))) < (B.minVolume ?? S.minVolume)) continue;
    group.sort((x, y) => hash(x.ticker) - hash(y.ticker));
    let kept = 0;
    for (const m of group.slice(0, B.perEvent * 3)) {
      if (kept >= B.perEvent) break;
      if (rows.length >= B.maxPerRun || calls >= B.maxCandleCalls) { complete = false; break outer; }
      // Resolution = earliest of close and settlement; snapshot = leadMinutes before it.
      const res = Math.min(...[m.close_time, m.settlement_ts].map(x => Date.parse(x)).filter(Number.isFinite));
      const T = res - B.leadMinutes * 6e4;
      if (Date.parse(m.open_time) > T) { skip("opened after snapshot time"); continue; }
      let s;
      try { s = await snapshot(m, T); } catch (e) { skip("candle error"); continue; }
      await sleep(150);
      if (!s) { skip("no price at snapshot time"); continue; }
      const mid = (s.ask + s.bid) / 2;
      if (!(s.bid > 0 && s.ask < 1 && s.ask > s.bid) || s.ask - s.bid > S.maxSpread) { skip("spread/one-sided"); continue; }
      if (mid < S.minMid || mid > S.maxMid) { skip("price near 0 or 100"); continue; }
      const { est, picks } = estimate({ mid, ask: s.ask, bid: s.bid, series: series(m), at: T }, { recall });
      rows.push({ bt: 1, ts: new Date(T).toISOString(), priceAt: new Date(s.at).toISOString(), cfg: config.version,
        ticker: m.ticker, event: m.event_ticker, series: series(m), cat: "",
        title: m.title + (m.yes_sub_title && !String(m.title).includes(m.yes_sub_title) ? " — " + m.yes_sub_title : ""),
        resolvesAt: new Date(res).toISOString(), ask: s.ask, bid: s.bid, mid: r4(mid), spread: r4(s.ask - s.bid),
        vol: Math.round(+(m.volume_fp || 0)), est, picks, y: m.result === "yes" ? 1 : 0, settledAt: m.settlement_ts || m.close_time });
      done.add(m.ticker); kept++;
    }
  }
  if (complete) { if (dir === "fwd") state.newest = Math.max(state.newest, b); else state.oldest = Math.min(state.oldest, a); }
}

const map = await categories(rows.map(r => r.series));
for (const r of rows) r.cat = map[r.series] || "";
const byMonth = {};
for (const r of rows) (byMonth[r.ts.slice(0, 7)] ||= []).push(r);
for (const [ym, rs] of Object.entries(byMonth)) appendJsonl(`data/backtest/${ym}.jsonl`, rs);
state.lastRun = now; writeJson(STATE, state);

// Backtest scorecard: same scoring as live, outcomes come from the rows themselves.
const all = backtestRows();
const sc = score(all, all.map(r => ({ ticker: r.ticker, result: r.y ? "yes" : "no", settledAt: r.settledAt, closedAt: r.resolvesAt })));
sc.note = "BACKTEST on already-settled markets (prices from Kalshi candles " + B.leadMinutes + " min before resolution). Supports, never replaces, the live record. " + sc.note;
sc.window = { from: new Date(state.oldest).toISOString(), to: new Date(state.newest).toISOString() };
// Sample check: in an unbiased sample, YES wins about as often as prices implied. A large gap means the selection leaked outcomes.
const yes = all.reduce((t, r) => t + r.y, 0) / (all.length || 1), price = all.reduce((t, r) => t + r.mid, 0) / (all.length || 1);
sc.sampleCheck = { yesRate: r4(yes), avgPrice: r4(price), gap: r4(yes - price),
  warning: all.length >= 200 && Math.abs(yes - price) > 0.05 ? "YES rate differs from average price by more than 5 points: check the sample for selection bias before trusting results" : null };
writeJson("backtest-scorecard.json", sc);
if (sc.sampleCheck.warning) console.log("WARNING:", sc.sampleCheck.warning, JSON.stringify(sc.sampleCheck));
console.log(`backtest: listed ${listed} settled, added ${rows.length} (candle calls ${calls}), total ${all.length}; skipped ${JSON.stringify(rejected)}; ` +
  Object.entries(sc.predictors).map(([k, v]) => `${k} brier ${v.brier.mean} vs mkt ${v.brierVsMarket.mean} (${v.verdict})`).join("; "));
