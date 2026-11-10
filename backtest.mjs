// Backtest agent: rebuilds "what would we have predicted" for markets that ALREADY settled, using Kalshi's public
// price history, then stores each result next to the official outcome.
// Selection uses only information available at the snapshot time T (= leadMinutes before resolution): for each event,
// one batch call returns every market's bid/ask at T and we keep the market priced nearest 50¢ (the live rule).
// Kept separate from the live record (data/backtest/, backtest-scorecard.json). The neural network is NOT estimated
// here (it trains on these rows); its honest test is the walk-forward run in nn.mjs.
import { config, kalshi, sleep, series, r4, readJson, writeJson, appendJsonl, categories } from "./lib.mjs";
import { estimate } from "./predictors.mjs";
import { loadSamples, makeRecall, backtestRows } from "./memory.mjs";
import { score } from "./score.mjs";

const B = { ...config.backtest, ...(process.env.BT_CALLS ? { maxCandleCalls: +process.env.BT_CALLS, maxPerRun: +process.env.BT_CALLS } : {}) };
const S = config.scan, now = Date.now(), excluded = new Set(B.excludeCategories || []);
const STATE = "data/backtest/state.json";
const state = readJson(STATE, { newest: 0, oldest: 0, lastRun: 0 });
if (process.env.FORCE !== "1" && now - state.lastRun < B.everyMinutes * 6e4) {
  console.log(`backtest: ran ${Math.round((now - state.lastRun) / 6e4)} min ago, next in ≤${B.everyMinutes} min — skipped`); process.exit(0);
}
const end = now - B.settleDelayHours * 36e5, floor = now - B.days * 864e5, slice = B.sliceHours * 36e5;
const slices = [];
if (!state.newest) state.newest = state.oldest = end;
for (let a = state.newest; a < end; a += slice) slices.push([a, Math.min(a + slice, end), "fwd"]);
for (let b = state.oldest; b > floor; b -= slice) slices.push([Math.max(b - slice, floor), b, "back"]);

const doneEvents = new Set(backtestRows().map(r => r.event));
const recall = makeRecall(loadSamples());
const rows = []; let calls = 0, listed = 0; const rejected = {};
const skip = why => { rejected[why] = (rejected[why] || 0) + 1; };

// Bid/ask of many markets at time T (unix seconds), from 1-minute candles: the last candle ending at or before T.
async function quotesAt(tickers, T) {
  const q = {};
  for (let i = 0; i < tickers.length; i += 100) {
    calls++;
    const j = await kalshi(`/markets/candlesticks?market_tickers=${tickers.slice(i, i + 100).map(encodeURIComponent).join(",")}&start_ts=${T - 1800}&end_ts=${T}&period_interval=1`);
    for (const m of j.markets || []) {
      const c = (m.candlesticks || []).filter(x => x.end_period_ts <= T && x.yes_bid?.close_dollars != null && x.yes_ask?.close_dollars != null).pop();
      const first = (m.candlesticks || []).find(x => x.end_period_ts <= T - 1500 && x.yes_bid?.close_dollars != null && x.yes_ask?.close_dollars != null);
      if (c) q[m.market_ticker] = { bid: +c.yes_bid.close_dollars, ask: +c.yes_ask.close_dollars,
        mid0: first ? (+first.yes_bid.close_dollars + +first.yes_ask.close_dollars) / 2 : null };
    }
    await sleep(200);
  }
  return q;
}

outer:
for (const [a, b, dir] of slices) {
  const ms = []; let cursor = "", pages = 0;
  do {
    const j = await kalshi(`/markets?status=settled&limit=1000&mve_filter=exclude&min_close_ts=${Math.floor(a / 1000)}&max_close_ts=${Math.floor(b / 1000)}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    ms.push(...(j.markets || [])); cursor = j.cursor; pages++; await sleep(250);
  } while (cursor && pages < 30);
  listed += ms.length;
  const byEvent = {};
  for (const m of ms) if (m.result === "yes" || m.result === "no") (byEvent[m.event_ticker] ||= []).push(m);
  // Liquidity judged per event (not per market, which would favor the eventual winner).
  const events = Object.values(byEvent).filter(g => !doneEvents.has(g[0].event_ticker) && Math.max(...g.map(m => +(m.volume_fp || 0))) >= (B.minVolume ?? S.minVolume));
  const cats = await categories(events.map(g => series(g[0])), 300);
  let complete = true;
  for (const group of events) {
    const cat = cats[series(group[0])];
    if (cat === undefined) { complete = false; continue; }      // category not known yet: retry next run
    if (excluded.has(cat)) { skip("excluded category"); continue; }
    if (rows.length >= B.maxPerRun || calls >= B.maxCandleCalls) { complete = false; break outer; }
    const res = Math.min(...group.flatMap(m => [m.close_time, m.settlement_ts]).map(x => Date.parse(x)).filter(Number.isFinite));
    const T = Math.floor((res - B.leadMinutes * 6e4) / 1000);
    const open = group.filter(m => Date.parse(m.open_time) / 1000 <= T - 60);
    if (!open.length) { skip("opened after snapshot time"); continue; }
    let q;
    try { q = await quotesAt(open.map(m => m.ticker), T); } catch { skip("candle error"); continue; }
    const cand = open.map(m => ({ m, ...q[m.ticker] })).filter(x => x.bid > 0 && x.ask < 1 && x.ask > x.bid && x.ask - x.bid <= S.maxSpread)
      .map(x => ({ ...x, mid: (x.ask + x.bid) / 2 })).filter(x => x.mid >= S.minMid && x.mid <= S.maxMid);
    if (!cand.length) { skip("no two-sided price at snapshot time"); continue; }
    const { m, ask, bid, mid, mid0 } = cand.sort((x, y) => Math.abs(x.mid - 0.5) - Math.abs(y.mid - 0.5))[0];
    const chg30 = mid0 == null ? null : r4(mid - mid0);
    const resAt = new Date(res).toISOString();
    const { est, picks } = estimate({ mid, ask, bid, series: series(m), at: T * 1000, cat, resolvesAt: resAt, chg30 }, { recall }, ["nn"]);
    rows.push({ bt: 1, ts: new Date(T * 1000).toISOString(), cfg: config.version, ticker: m.ticker, event: m.event_ticker, series: series(m), cat,
      title: m.title + (m.yes_sub_title && !String(m.title).includes(m.yes_sub_title) ? " — " + m.yes_sub_title : ""),
      resolvesAt: resAt, ask, bid, mid: r4(mid), spread: r4(ask - bid), chg30, est, picks, y: m.result === "yes" ? 1 : 0, settledAt: m.settlement_ts || m.close_time });
    doneEvents.add(m.event_ticker);
  }
  if (complete) { if (dir === "fwd") state.newest = Math.max(state.newest, b); else state.oldest = Math.min(state.oldest, a); }
}

const byMonth = {};
for (const r of rows) (byMonth[r.ts.slice(0, 7)] ||= []).push(r);
for (const [ym, rs] of Object.entries(byMonth)) appendJsonl(`data/backtest/${ym}.jsonl`, rs);
state.lastRun = now; writeJson(STATE, state);

const all = backtestRows();
const sc = score(all, all.map(r => ({ ticker: r.ticker, result: r.y ? "yes" : "no", settledAt: r.settledAt, closedAt: r.resolvesAt })));
sc.note = "BACKTEST on already-settled markets (prices from Kalshi candles " + B.leadMinutes + " min before resolution). Supports, never replaces, the live record. " + sc.note;
sc.window = { from: new Date(state.oldest).toISOString(), to: new Date(state.newest).toISOString() };
// Sample check: in an unbiased sample YES wins about as often as prices implied. A big gap suggests selection leaked outcomes.
const yes = all.reduce((t, r) => t + r.y, 0) / (all.length || 1), price = all.reduce((t, r) => t + r.mid, 0) / (all.length || 1);
sc.sampleCheck = { yesRate: r4(yes), avgPrice: r4(price), gap: r4(yes - price),
  warning: all.length >= 200 && Math.abs(yes - price) > 0.05 ? "YES rate differs from average price by more than 5 points: check the sample for selection bias before trusting results" : null };
writeJson("backtest-scorecard.json", sc);
if (sc.sampleCheck.warning) console.log("WARNING:", sc.sampleCheck.warning, JSON.stringify(sc.sampleCheck));
console.log(`backtest: listed ${listed} settled, added ${rows.length} (candle calls ${calls}), total ${all.length}; skipped ${JSON.stringify(rejected)}; ` +
  Object.entries(sc.predictors).map(([k, v]) => `${k} brier ${v.brier.mean} vs mkt ${v.brierVsMarket.mean} (${v.verdict})`).join("; "));
