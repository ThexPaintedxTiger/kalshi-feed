// Research step: find Kalshi markets that resolve within the next few hours, estimate probabilities with each enabled
// predictor, and APPEND one prediction per market to data/predictions/YYYY-MM.jsonl BEFORE the market resolves.
// Rows are never edited afterwards. Simulation only: nothing is traded.
// Split in three so the live daemon can reuse the parts: discover() → select() → logPredictions().
import { minuteStats, bookImbalance, tradeFlow, takerSide } from "./nnlib.mjs";
import { config, kalshi, sleep, resolvesAt, series, r4, categories, writeJson } from "./lib.mjs";
import { estimate } from "./predictors.mjs";
import * as crypto from "./external/crypto.mjs";
import * as weather from "./external/weather.mjs";

const S = config.scan;
// Outside-data agents: only for predictors that are switched on.
const AGENTS = [["crypto", crypto, s => config.predictors.crypto_fair?.on && crypto.product(s)], ["weather", weather, s => config.predictors.weather_nws?.on && weather.covers(s)]];

// 1. Discover: open single markets (no multi-leg combos) closing inside the window.
export async function discover(now = Date.now()) {
  const nowS = Math.floor(now / 1000), markets = []; let cursor = "", pages = 0;
  do {
    const j = await kalshi(`/markets?status=open&limit=1000&mve_filter=exclude&min_close_ts=${nowS}&max_close_ts=${nowS + S.windowDays * 86400}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    markets.push(...(j.markets || [])); cursor = j.cursor; pages++; await sleep(250);
  } while (cursor && pages < 120);
  return { markets, pages };
}

// 2. Filter (resolves soon but not too soon; liquid; priced away from 0/100), skip tickers already logged, keep ≤ perEvent
//    per event nearest 50¢, then take round-robin across categories so one category can't fill the run.
export function candidates(markets, now = Date.now()) {
  const minLead = S.minLeadMinutes * 60e3, horizon = S.horizonHours * 36e5, cand = [];
  for (const m of markets) {
    const ask = +m.yes_ask_dollars, bid = +m.yes_bid_dollars, res = resolvesAt(m), lead = Date.parse(res) - now, mid = (ask + bid) / 2;
    if (!(lead >= minLead && lead <= horizon)) continue;
    if (!(bid > 0 && ask < 1 && ask > bid) || ask - bid > S.maxSpread) continue;
    if (+(m.volume_fp || 0) < S.minVolume || mid < S.minMid || mid > S.maxMid) continue;
    cand.push({ m, ask, bid, mid, res, lead });
  }
  return cand;
}
export function select(cand, seen, cats, max = S.maxNewPerRun) {
  const byEvent = {};
  for (const c of cand) if (!seen.has(c.m.ticker)) (byEvent[c.m.event_ticker] ||= []).push(c);
  const pool = Object.values(byEvent).flatMap(a => a.sort((x, y) => Math.abs(x.mid - 0.5) - Math.abs(y.mid - 0.5)).slice(0, S.perEvent));
  pool.sort((a, b) => +(b.m.volume_24h_fp || 0) - +(a.m.volume_24h_fp || 0));
  const byCat = {}, excluded = new Set(S.excludeCategories || []);
  for (const c of pool) { const cat = cats[series(c.m)] || "?"; if (!excluded.has(cat)) (byCat[cat] ||= []).push(c); }
  const chosen = [];
  for (let i = 0; chosen.length < max && Object.values(byCat).some(a => a.length > i); i++)
    for (const a of Object.values(byCat)) if (a[i] && chosen.length < max) chosen.push(a[i]);
  return chosen;
}

// 3. Features as of now (public endpoints), outside data, estimates → append rows.
export async function logPredictions(ctx, chosen, now = Date.now(), cats = {}, feat = null) {
  const nowS = Math.floor(now / 1000), runId = new Date(now).toISOString(), sha = (process.env.GITHUB_SHA || ctx.host || "local").slice(0, 7);
  const move = {}, vol = {}, book = {};
  if (!feat) {
    try {                                                                         // 30-minute move + minute volatility: one batch candle call
      for (let i = 0; i < chosen.length; i += 100) {
        const j = await kalshi(`/markets/candlesticks?market_tickers=${chosen.slice(i, i + 100).map(c => encodeURIComponent(c.m.ticker)).join(",")}&start_ts=${nowS - 2100}&end_ts=${nowS}&period_interval=1`);
        for (const mk of j.markets || []) {
          const all = (mk.candlesticks || []).filter(c => c.yes_bid?.close_dollars != null && c.yes_ask?.close_dollars != null);
          const pts = all.filter(c => c.end_period_ts <= nowS - 1500);
          if (pts.length) move[mk.market_ticker] = (+pts[0].yes_bid.close_dollars + +pts[0].yes_ask.close_dollars) / 2;
          const v = minuteStats(all.map(c => ({ t: c.end_period_ts, mid: (+c.yes_bid.close_dollars + +c.yes_ask.close_dollars) / 2 })), nowS).vol30;
          if (v != null) vol[mk.market_ticker] = v;
        }
      }
    } catch (e) { ctx.log("price-move lookup failed: " + e.message); }
    for (const { m } of chosen) {                                                 // order book (top 5) + last 30 min of trades
      try {
        const t = encodeURIComponent(m.ticker), ob = (await kalshi(`/markets/${t}/orderbook?depth=5`)).orderbook_fp || {};
        const tr = await kalshi(`/markets/trades?ticker=${t}&min_ts=${nowS - 1800}&limit=1000`);
        const trades = (tr.trades || []).filter(x => !x.is_block_trade).map(x => ({ t: Date.parse(x.created_time) / 1000, side: takerSide(x), n: +x.count_fp || 0 }));
        book[m.ticker] = { imb5: bookImbalance(ob.yes_dollars, ob.no_dollars), ...tradeFlow(trades, nowS) };
      } catch (e) { ctx.log(`book lookup failed on ${m.ticker}: ${e.message}`); }
      await sleep(100);
    }
  }
  const ext = {}, extStat = Object.fromEntries(AGENTS.map(([k]) => [k, { tried: 0, got: 0 }]));
  for (const { m } of chosen) {
    const s = series(m), ag = AGENTS.find(a => a[2](s)); if (!ag) continue;
    extStat[ag[0]].tried++;
    try { const e = await ag[1].estimate(m, now, s); if (e) { ext[m.ticker] = { [ag[0]]: e }; extStat[ag[0]].got++; } }
    catch (e) { ctx.log(`${ag[0]} agent failed on ${m.ticker}: ${e.message}`); }
  }
  ctx.emit("external", { at: runId, ...extStat }, "state");
  const rows = chosen.map(({ m, ask, bid, mid, res, lead }) => {
    const f = feat?.[m.ticker], bk = book[m.ticker] || {};
    const chg30 = f ? f.chg30 ?? null : m.ticker in move ? r4(mid - move[m.ticker]) : null, vol30 = f ? f.vol30 ?? null : vol[m.ticker] ?? null;
    const imb5 = (f ?? bk).imb5 ?? null, flow30 = (f ?? bk).flow30 ?? null, vol30t = (f ?? bk).vol30t ?? null, cat = cats[series(m)] || "";
    const { est, picks } = estimate({ mid, ask, bid, series: series(m), at: now, cat, resolvesAt: res, leadMin: lead / 6e4, chg30, vol30, imb5, flow30, ext: ext[m.ticker] }, { recall: ctx.recall });
    return {
      ts: runId, run: sha, cfg: config.version, ticker: m.ticker, event: m.event_ticker, series: series(m), cat,
      title: m.title + (m.yes_sub_title && !String(m.title).includes(m.yes_sub_title) ? " — " + m.yes_sub_title : ""),
      rules: String(m.rules_primary || "").slice(0, 300),
      ...(m.strike_type ? { strike: { type: m.strike_type, floor: m.floor_strike ?? null, cap: m.cap_strike ?? null } } : {}),
      resolvesAt: res, leadMin: Math.round(lead / 6e4), chg30, vol30, imb5, flow30, vol30t, ...(ext[m.ticker] ? { ext: ext[m.ticker] } : {}),
      ask, bid, mid: r4(mid), spread: r4(ask - bid), askSize: +(m.yes_ask_size_fp || 0), bidSize: +(m.yes_bid_size_fp || 0),
      vol: Math.round(+(m.volume_fp || 0)), v24: Math.round(+(m.volume_24h_fp || 0)), oi: Math.round(+(m.open_interest_fp || 0)),
      est, picks, src: `${feat ? "ws+" : ""}GET /trade-api/v2/markets @ ${runId}`,
    };
  });
  ctx.store.append("predictions", rows, new Date(now));
  return rows;
}

export async function run(ctx) {
  const now = Date.now(), { markets, pages } = await discover(now), cand = candidates(markets, now), seen = new Set(ctx.store.pred.keys());
  const cats = await categories([...cand.filter(c => !seen.has(c.m.ticker)).map(c => series(c.m)), ...ctx.store.preds.slice(-500).map(p => p.series)]);
  const chosen = select(cand, seen, cats), lf = ctx.liveFeat || {};
  // Markets the live stream already has a synced book for use its features; the rest use the public endpoints.
  const viaWs = chosen.filter(c => lf[c.m.ticker]), viaRest = chosen.filter(c => !lf[c.m.ticker]);
  const rows = [...(viaWs.length ? await logPredictions(ctx, viaWs, now, cats, lf) : []), ...(viaRest.length ? await logPredictions(ctx, viaRest, now, cats) : [])];
  ctx.store.append("runs", [{ ts: new Date(now).toISOString(), run: rows[0]?.run || (process.env.GITHUB_SHA || ctx.host || "local").slice(0, 7), scanned: markets.length, candidates: cand.length, logged: rows.length }]);
  ctx.scan = { at: now, scanned: markets.length, cand };                                          // reused by the daemon (what is in scope right now)
  return `predict: scanned ${markets.length} markets (${pages} pages), ${cand.length} resolve in ${S.minLeadMinutes}m–${S.horizonHours}h, logged ${rows.length} new`;
}
if (import.meta.url === `file://${process.argv[1]}`) { const { makeCtx } = await import("./core/ctx.mjs"); console.log(await run(makeCtx())); }
