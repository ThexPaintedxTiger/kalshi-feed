// Live daemon — the 24/7 process on the owner's computer. Start it with start.sh / start.cmd (they restart it if it exits).
//
//   Kalshi WebSocket (read-only key in private/) ─► engine (books, features, re-estimates, settlements)
//        │ no key / stream down: public REST prices every 30 s, same engine
//        ├─► local/ticks, local/features (compressed, append-only, never pushed)
//        ├─► http://localhost:8787  dashboard + Server-Sent Events (sub-second)
//        ├─► site/live.json + heartbeat.json → `site` branch every 2 min (GitHub Pages, for viewing away from home)
//        └─► logs on main every 15 min
//   Events:  settlement message → outcome row → rescore/train at once (REST lookup every 5 min as the fallback)
//            price/book change on a logged market → re-estimate (update row; the first row stays the scored prediction)
//   Timers:  scan for new markets every 10 min · scorecard/dashboard every minute · backtest, network, archive hourly
// Options (env): NO_PUSH=1 never push · NO_KEY=1 ignore the key (REST only) · RECORD_RAW=1 keep every stream message
//                (local/raw/, for replay tests) · PORT=8787 · STREAM_MINUTES=n stop after n minutes
import { hostname } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { makeCtx } from "../core/ctx.mjs";
import { derive, perf } from "../cycle.mjs";
import * as resolveStep from "../resolve.mjs";
import * as predictStep from "../predict.mjs";
import * as backtestStep from "../backtest.mjs";
import * as train from "../models/train.mjs";
import * as maker from "../maker.mjs";
import * as agentjobs from "../agentjobs.mjs";
import * as archive from "../archive.mjs";
import { estimate, disable } from "../predictors.mjs";
import { pushMain, pushSite } from "../publish.mjs";
import { config, kalshi, sleep, series, readJson, appendJsonl, r4 } from "../lib.mjs";
import { hasKey, privateIgnored, connectStream } from "../kalshi-auth.mjs";
import { Engine } from "./engine.mjs";
import { setReference } from "../external/crypto.mjs";
import { KalshiWS } from "./ws.mjs";
import { GzLog } from "./ticklog.mjs";
import { Alerts, evaluate as alertRules } from "./alerts.mjs";
import { startServer } from "./server.mjs";

const L = { port: 8787, maxMarkets: 800, restPollSec: 30, scanEveryMin: 10, ...(config.live || {}) };
const PENDING = "local/pending-snaps.jsonl";

export function createDaemon({ ctx = makeCtx(), connect = null, now = Date.now, log = console.log, alerts = new Alerts({ now }), kalshiFn = kalshi, port = L.port, serve = true, record = false, offline = false } = {}) {
  const D = { ctx, started: now(), minute: 0, staleSec: 0, lastRest: now(), lastOutcomeCheck: 0, dirty: false, busy: false, last: {}, msgRate: 0, _msgs: 0 };
  ctx.host = "daemon"; ctx.log = log; ctx.quiet = true;                  // steps return their summary line; the daemon logs the ones worth reading
  const engine = D.engine = new Engine({ estimate: c => estimate(c, { recall: ctx.recall }), cfg: L });
  const ticks = new GzLog("local/ticks"), feats = new GzLog("local/features", { flushRows: 5000 }), raw = record ? new GzLog("local/raw", { flushRows: 5000 }) : null;
  const ws = D.ws = connect ? new KalshiWS({ connect, now, log, indices: L.indices || [] }) : null;
  setReference(id => engine.index?.get(id) || null);
  if (ws) {
    ws.on("message", m => { const t = now(); raw?.add([{ t, m }], t); engine.onMessage(m, t); });
    ws.on("state", s => { engine.setLive(s === "live"); raw?.add([{ t: now(), m: { type: "_state", live: s === "live" } }], now()); log(`stream: ${s}`); });
    ws.on("gap", why => log(`stream gap (${why}) — asked for fresh snapshots`));
  }
  // Training snapshots wait here until their market settles (they need the outcome). Survives restarts.
  const pending = new Map();
  if (existsSync(PENDING)) for (const l of readFileSync(PENDING, "utf8").split("\n").filter(Boolean)) { try { const r = JSON.parse(l); if (!ctx.store.out.has(r.ticker) && now() - Date.parse(r.ts) < 8 * 864e5) (pending.get(r.ticker) || pending.set(r.ticker, []).get(r.ticker)).push(r); } catch {} }
  const savePending = () => { mkdirSync("local", { recursive: true }); writeFileSync(PENDING, [...pending.values()].flat().map(r => JSON.stringify(r)).join("\n") + (pending.size ? "\n" : "")); };

  // ---- scope: what the stream watches = open logged predictions first, then the most active candidates.
  D.rescope = () => {
    const t = now(), cats = readJson("data/series.json", { map: {} }).map, excluded = new Set(config.scan.excludeCategories || []), list = [], seen = new Set();
    for (const p of ctx.store.open(t, 0)) { seen.add(p.ticker); list.push({ ticker: p.ticker, event: p.event, series: p.series, cat: p.cat, title: p.title, resolvesAt: p.resolvesAt, logged: true, loggedAt: Date.parse(p.ts), mid0: p.mid, ext: p.ext }); }
    const cand = (ctx.scan?.cand || []).filter(c => !seen.has(c.m.ticker) && Date.parse(c.res) > t && !excluded.has(cats[series(c.m)])).sort((a, b) => +(b.m.volume_24h_fp || 0) - +(a.m.volume_24h_fp || 0));
    for (const c of cand.slice(0, Math.max(0, L.maxMarkets - list.length))) list.push({ ticker: c.m.ticker, event: c.m.event_ticker, series: series(c.m), cat: cats[series(c.m)] || "", title: c.m.title, resolvesAt: c.res, logged: false });
    engine.setScope(list); ws?.setMarkets(list.map(x => x.ticker));
    return list.length;
  };

  // ---- settlements from the stream: outcome row at once, then the market's training snapshots get their label.
  function settle(list) {
    const rows = [], t = now();
    for (const s of list) {
      const p = ctx.store.pred.get(s.ticker); if (!p || ctx.store.out.has(s.ticker) || (s.result !== "yes" && s.result !== "no")) continue;
      const det = new Date(s.determinedAt).toISOString();
      rows.push({ ticker: s.ticker, result: s.result, raw: s.result, status: "determined", settledAt: det, closedAt: Date.parse(p.resolvesAt) < s.determinedAt ? p.resolvesAt : det, checkedAt: new Date(t).toISOString(), via: "ws" });
    }
    if (rows.length) { ctx.store.append("outcomes", rows); labelSnaps(rows.map(r => r.ticker)); D.dirty = true; D.fresh = (D.fresh || 0) + rows.length; D.rescope(); }   // settled markets leave the watched set
    return rows.length;
  }
  function labelSnaps(tickers) {
    const out = [];
    for (const k of tickers) { const y = ctx.store.result(k), rs = pending.get(k); if (rs && y != null) for (const r of rs) out.push({ ...r, y, cfg: config.version }); pending.delete(k); }
    if (out.length) ctx.store.append("snapshots", out);
    if (tickers.length) savePending();
  }

  // ---- once a second: advance the engine, write what it produced.
  D.second = () => {
    const t = now(), out = engine.onClock(t);
    if (out.ticks.length) ticks.add(out.ticks, t);
    if (out.features.length) feats.add(out.features, t);
    if (out.snaps.length) { for (const r of out.snaps) (pending.get(r.ticker) || pending.set(r.ticker, []).get(r.ticker)).push(r); mkdirSync("local", { recursive: true }); appendFileSync(PENDING, out.snaps.map(r => JSON.stringify(r)).join("\n") + "\n"); }
    if (out.updates.length) appendJsonl(`data/updates/${new Date(t).toISOString().slice(0, 7)}.jsonl`, out.updates.map(u => ({ ...u, cfg: config.version })));
    settle(engine.takeSettled());
    // Staleness: a second counts as stale when neither the stream nor a recent REST poll is feeding prices.
    if (!(ws?.state === "live") && t - D.lastRest > 2 * L.restPollSec * 1000) D.staleSec++;
    const m = ws?.stats.messages || 0; D.msgRate = m - D._msgs; D._msgs = m;
    server?.push("health", D.health(t));
    return out;
  };
  D.fast = () => { const ch = engine.takeChanged(); if (ch.length && server?.clients()) { const t = now(); server.push("tick", ch.slice(0, 400).map(k => engine.view(k, t)).filter(Boolean)); } };
  D.health = (t = now()) => ({ at: new Date(t).toISOString(), host: hostname(), startedAt: new Date(D.started).toISOString(), minute: D.minute, mode: ws?.state === "live" ? "ws" : "rest", keyed: !!ws,
    ws: ws ? ws.health() : { state: "off" }, msgRate: D.msgRate, staleTotalSec: D.staleSec, ...engine.staleness(t), port: D.port || null, viewers: server?.clients() || 0,
    ticks: { rows: ticks.rows + ticks.buf.length, mb: r4(ticks.bytes / 1048576) }, rssMB: Math.round(process.memoryUsage().rss / 1048576) });

  // ---- REST fallback for prices (no key, or the stream is down).
  async function restPrices() {
    const t = now(), open = ctx.store.open(t, 0).map(p => p.ticker); D.lastRest = t;
    for (let i = 0; i < open.length; i += 200) {
      const j = await kalshiFn(`/markets?limit=1000&tickers=${open.slice(i, i + 200).map(encodeURIComponent).join(",")}`);
      for (const m of j.markets || []) engine.onRest(m.ticker, +m.yes_bid_dollars, +m.yes_ask_dollars, now());
    }
  }
  // ---- serialized background jobs (a long scan never overlaps a rescore).
  const job = async (name, fn) => { if (D.busy) return false; D.busy = true; try { await fn(); } catch (e) { log(`${name}: ${e.message}`); } finally { D.busy = false; } return true; };
  const due = (name, everyMs) => { const t = now(); if (t - (D.last[name] || 0) < everyMs) return false; D.last[name] = t; return true; };
  const rescore = async (full) => { const t0 = performance.now(); ctx.timings = []; if (D.fresh) { D.fresh = 0; await ctx.step("models (settled)", train.onSettle); } await derive(ctx, { full, mirror: full }); D.dirty = false; server?.push("derived", { at: new Date().toISOString() }); return perf(ctx, full ? "derive" : "settle", t0); };

  D.tick = async () => {                                       // called every ~10 s; each part has its own schedule
    const t = now();
    if (ws?.state !== "live" && due("rest", L.restPollSec * 1000)) await job("rest prices", restPrices);
    if (!offline && due("scan", L.scanEveryMin * 6e4)) await job("scan", async () => {
      const feat = {}; for (const [k, mk] of engine.markets) if (mk.synced) { const f = mk.features(now()); if (f?.mid != null) feat[k] = f; }
      ctx.liveFeat = feat; log(await ctx.step("predict", predictStep.run)); log(`watching ${D.rescope()} markets`); D.dirty = true; }) || (D.last.scan = 0);
    if (due("outcomes", 5 * 6e4)) await job("outcomes", async () => { const before = ctx.store.out.size; await ctx.step("resolve", resolveStep.run);
      if (ctx.store.out.size > before) { labelSnaps([...ctx.store.out.keys()].filter(k => pending.has(k))); D.dirty = true; D.fresh = (D.fresh || 0) + ctx.store.out.size - before; D.rescope(); } });
    if (due("hourly", 60 * 6e4)) await job("hourly", async () => { const a = archive.run(); if (a.moved.length) ctx.store.refresh(); if (!offline) log(await ctx.step("backtest", backtestStep.run)); log(await ctx.step("models", train.hourly)); if (!offline) { log(await ctx.step("maker", c => maker.run(c))); log(await ctx.step("llm jobs", agentjobs.run)); } await rescore(true); });
    if (D.dirty && due("settle", 2000)) await job("rescore", () => rescore(false));
    if (due("minute", 6e4)) {
      D.minute++; ticks.flush(); feats.flush(); raw?.flush();
      const h = ctx.emit("heartbeat", D.health());
      ctx.emit("live", { at: h.at, health: h, markets: [...engine.meta.values()].filter(m => m.logged).map(m => engine.view(m.ticker, now())).filter(Boolean).slice(0, 150) });
      await job("minute rescore", () => rescore(false));
      await raiseAlerts();
    }
    if (due("site", config.publish.siteEveryMinutes * 6e4)) { const r = pushSite(`minute ${D.minute}`); if (/FAILED/.test(r)) log(r); }
    if (due("main", config.publish.mainEveryMinutes * 6e4) && D.minute > 1) log(pushMain(`daemon minute ${D.minute}`));
  };
  async function raiseAlerts() {
    const ev = ctx.get("evals"), paper = ctx.get("paper");
    // The agent's own decisions: a model the referee calls clearly worse than the market is switched off (logged, reversible).
    for (const m of Object.values(ev?.models || {})) if (m.status === "FAILURE_WORSE" && disable(m.model, `peeking-safe test: worse than the market (${m.vsMarket.sequence.lo}…${m.vsMarket.sequence.hi} over ${m.n} resolved)`, now())) log(`decision: ${m.model} switched off (worse than the market)`);
    const snap = { streamDownSec: ws && ws.state !== "live" ? (now() - (ws.stats.downSince ?? now())) / 1000 : null, downMin: D.downMin ?? null,
      predictors: Object.fromEntries(Object.values(ev?.models || {}).map(m => [m.model, { on: config.predictors[m.model]?.on, n: m.n, vsMarket: m.vsMarket.snapshot95.diff, status: m.status }])),
      portfolios: paper?.forward?.portfolios || [], llm: ctx.get("llm-usage", "state") };
    D.downMin = null;
    for (const a of alertRules(snap, config.alerts)) { if (a.action?.disable) disable(a.action.disable, a.body, now()); if (await alerts.raise(a.key, a.title, a.body, a)) log(`ALERT: ${a.title} — ${a.body}`); }
    ctx.emit("alerts", { at: new Date().toISOString(), recent: alerts.recent.slice(-20), configured: !!alerts.tgt });
  }

  let server = null;
  D.start = async () => {
    const prev = readJson("site/heartbeat.json", null);
    if (prev?.at) { const gap = (now() - Date.parse(prev.at)) / 6e4; if (gap > 2 && gap < 7 * 1440) D.downMin = gap; }
    if (serve) await new Promise(res => { server = startServer({ port, state: () => ({ health: D.health(), markets: [...engine.meta.keys()].map(k => engine.view(k, now())).filter(Boolean) }), market: k => engine.view(k, now(), true),
      onListen: (err, p) => { if (err) { log(`live page not started: ${err.message}`); server = null; } else { D.port = p; log(`live page: http://localhost:${p}`); } res(); } }); });
    if (!ctx.get("ensemble", "state")) { log("first start: training models from the logs…"); log(await ctx.step("models", c => train.hourly(c, { force: true }))); }
    D.rescope(); ws?.start(); ctx.emit("heartbeat", D.health());
  };
  D.stop = () => { ws?.stop(); ticks.flush(); feats.flush(); raw?.flush(); savePending(); server?.close(); };
  return D;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = m => m && console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`), LIMIT = +process.env.STREAM_MINUTES || Infinity;
  const keyed = process.env.NO_KEY !== "1" && hasKey() && privateIgnored();
  const D = createDaemon({ connect: keyed ? connectStream : null, log, port: +process.env.PORT || L.port, record: process.env.RECORD_RAW === "1" });
  log(`live daemon on ${hostname()} — ${keyed ? "Kalshi stream ON (read-only key)" : hasKey() ? "key found but private/ is not git-ignored: key NOT used" : "no key in private/: public REST prices only"}${process.env.NO_PUSH === "1" ? " · NO_PUSH" : ""}`);
  await D.start();
  let stop = false; process.on("SIGINT", () => { if (stop) process.exit(1); stop = true; log("stopping… (Ctrl+C again to stop now)"); });
  const s1 = setInterval(() => { try { D.second(); } catch (e) { log(`clock: ${e.message}`); } }, 1000), s2 = setInterval(() => { try { D.fast(); } catch {} }, 250);
  while (!stop && Date.now() - D.started < LIMIT * 6e4) { await D.tick().catch(e => log(`tick: ${e.message}`)); await sleep(5000); }
  clearInterval(s1); clearInterval(s2); D.stop(); log(pushMain("daemon stopping")); pushSite("daemon stopping"); log("daemon stopped"); process.exit(0);
}
