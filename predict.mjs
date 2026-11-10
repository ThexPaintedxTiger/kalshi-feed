// Research step: find Kalshi markets that resolve within the next few hours, estimate probabilities
// with each enabled predictor, and APPEND one prediction per market to data/predictions/YYYY-MM.jsonl
// BEFORE the market resolves. Rows are never edited afterwards. Simulation only: nothing is traded.
import { config, kalshi, sleep, ev, resolvesAt, series, r4, readJsonl, appendJsonl, predictionFiles, readJson, writeJson } from "./lib.mjs";

const S = config.scan, now = Date.now(), nowS = Math.floor(now / 1000);
const runId = new Date(now).toISOString();
const sha = (process.env.GITHUB_SHA || "local").slice(0, 7);

// 1. Discover: open single markets (no multi-leg combos) closing inside the window.
const markets = [];
let cursor = "", pages = 0;
do {
  const j = await kalshi(`/markets?status=open&limit=1000&mve_filter=exclude&min_close_ts=${nowS}&max_close_ts=${nowS + S.windowDays * 86400}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
  markets.push(...(j.markets || [])); cursor = j.cursor; pages++;
  await sleep(250);
} while (cursor && pages < 120);

// 2. Filter: resolves soon, but not too soon to act; liquid; priced away from 0/100.
const minLead = S.minLeadMinutes * 60e3, horizon = S.horizonHours * 36e5;
const cand = [];
for (const m of markets) {
  const ask = +m.yes_ask_dollars, bid = +m.yes_bid_dollars, res = resolvesAt(m);
  const lead = Date.parse(res) - now, mid = (ask + bid) / 2;
  if (!(lead >= minLead && lead <= horizon)) continue;
  if (!(bid > 0 && ask < 1 && ask > bid) || ask - bid > S.maxSpread) continue;
  if (+(m.volume_fp || 0) < S.minVolume || mid < S.minMid || mid > S.maxMid) continue;
  cand.push({ m, ask, bid, mid, res, lead });
}

// 3. Log each market once: skip tickers already predicted; per event keep the markets nearest 50¢
//    (most uncertain = most informative), then the most active events first.
const seen = new Set(predictionFiles().flatMap(f => readJsonl(f)).map(p => p.ticker));
const byEvent = {};
for (const c of cand) if (!seen.has(c.m.ticker)) (byEvent[c.m.event_ticker] ||= []).push(c);
let pool = Object.values(byEvent).flatMap(a => a.sort((x, y) => Math.abs(x.mid - 0.5) - Math.abs(y.mid - 0.5)).slice(0, S.perEvent));
pool.sort((a, b) => +(b.m.volume_24h_fp || 0) - +(a.m.volume_24h_fp || 0));

// 4. Categories: cache only the series we meet; refresh the full list at most once a day.
const cats = readJson("data/series.json", { fetched: 0, map: {} });
if (pool.some(c => !(series(c.m) in cats.map)) && now - cats.fetched > 864e5) {
  try {
    const all = Object.fromEntries(((await kalshi("/series")).series || []).map(s => [s.ticker, s.category || ""]));
    for (const c of pool) cats.map[series(c.m)] = all[series(c.m)] ?? "";
    cats.fetched = now;
  } catch (e) { console.log("series lookup failed:", e.message); }
}
// Take markets round-robin across categories (most active first within each) so one category can't fill the run.
const byCat = {};
for (const c of pool) (byCat[cats.map[series(c.m)] || "?"] ||= []).push(c);
const chosen = [];
for (let i = 0; chosen.length < S.maxNewPerRun && Object.values(byCat).some(a => a.length > i); i++)
  for (const a of Object.values(byCat)) if (a[i] && chosen.length < S.maxNewPerRun) chosen.push(a[i]);

// 5. Predictors (hypotheses live in config.json, versioned by "cfg"). Each returns a YES probability from data available NOW (no future information).
const logit = p => Math.log(p / (1 - p)), sigm = x => 1 / (1 + Math.exp(-x));
const PRED = {
  market: c => c.mid,
  longshot: c => sigm(config.predictors.longshot.slope * logit(c.mid)),
};
const on = Object.keys(PRED).filter(k => config.predictors[k]?.on);

const rows = chosen.map(({ m, ask, bid, mid, res, lead }) => {
  const est = {}, picks = {};
  for (const k of on) {
    const p = r4(PRED[k]({ m, ask, bid, mid })), e = ev(p, ask, bid);
    est[k] = p;
    const side = e.yes >= e.no ? "yes" : "no", edge = Math.max(e.yes, e.no);
    if (edge >= config.picks.minEdge) picks[k] = { side, ev: r4(edge), cost: side === "yes" ? ask : r4(1 - bid) };
  }
  return {
    ts: runId, run: sha, cfg: config.version,
    ticker: m.ticker, event: m.event_ticker, series: series(m), cat: cats.map[series(m)] || "",
    title: m.title + (m.yes_sub_title && !String(m.title).includes(m.yes_sub_title) ? " — " + m.yes_sub_title : ""),
    rules: String(m.rules_primary || "").slice(0, 300),
    resolvesAt: res, leadMin: Math.round(lead / 6e4),
    ask, bid, mid: r4(mid), spread: r4(ask - bid), askSize: +(m.yes_ask_size_fp || 0), bidSize: +(m.yes_bid_size_fp || 0),
    vol: Math.round(+(m.volume_fp || 0)), v24: Math.round(+(m.volume_24h_fp || 0)), oi: Math.round(+(m.open_interest_fp || 0)),
    est, picks,
    src: `${"GET /trade-api/v2/markets"} @ ${runId}`,
  };
});

const [, file] = predictionFiles();
appendJsonl(file, rows);
writeJson("data/series.json", cats);
console.log(`scanned ${markets.length} markets (${pages} pages), ${cand.length} resolve in ${S.minLeadMinutes}m–${S.horizonHours}h, logged ${rows.length} new → ${file}`);
