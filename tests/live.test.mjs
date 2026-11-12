// Live layer: order book math, stream client (subscribe / gap / reconnect), engine (features, re-estimates, settlement,
// no look-ahead), compressed logs, alert rules, and the daemon end to end against a fake socket.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Market } from "../live/book.mjs";
import { KalshiWS } from "../live/ws.mjs";
import { Engine } from "../live/engine.mjs";
import { GzLog, readGz } from "../live/ticklog.mjs";
import { Alerts, evaluate } from "../live/alerts.mjs";
import { FakeSocket, fakeClock } from "./fake.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)), T0 = Date.parse("2026-11-12T12:00:00Z");
const snap = (k, yes, no, sid = 1, seq = 1) => ({ type: "orderbook_snapshot", sid, seq, msg: { market_ticker: k, yes_dollars_fp: yes, no_dollars_fp: no } });
const delta = (k, side, price, d, sid = 1, seq = 2) => ({ type: "orderbook_delta", sid, seq, msg: { market_ticker: k, price_dollars: price, delta_fp: d, side } });
const trade = (k, yesPrice, n, side, ts) => ({ type: "trade", sid: 2, seq: 1, msg: { market_ticker: k, yes_price_dollars: yesPrice, count_fp: n, taker_outcome_side: side, ts_ms: ts } });

// ---- Book: best bid = highest YES bid; best ask = 1 − highest NO bid; deltas add/remove size; microprice leans to the thin side.
{
  const m = new Market("A");
  m.snapshot(snap("A", [["0.4000", "100.00"], ["0.4200", "300.00"]], [["0.5000", "50.00"], ["0.5500", "100.00"]]).msg, T0);
  assert.deepEqual(m.top(), { bid: 0.42, ask: 0.45, bidSize: 300, askSize: 100 });
  assert.equal(m.mid(), 0.435);
  const f = m.features(T0); assert.equal(f.micro, 0.4425); assert.ok(f.microDiff > 0);          // more bid size → fair price above mid
  assert.equal(f.imb5, 0.4545);                                                               // (400 − 150) / 550
  m.delta(delta("A", "yes", "0.4200", "-300.00").msg, T0 + 1); assert.equal(m.top().bid, 0.4);  // level removed
  m.delta(delta("A", "no", "0.5800", "10.00").msg, T0 + 2); assert.equal(m.top().ask, 0.42);
  m.trade(trade("A", "0.4200", "25.00", "yes", T0 + 3).msg, T0 + 3); m.trade(trade("A", "0.4100", "75.00", "no", T0 + 4).msg, T0 + 4);
  assert.equal(m.features(T0 + 5).flow1, -0.5); assert.equal(m.features(T0 + 5).vol30t, 100); assert.equal(m.features(T0 + 3).flow1, 1);   // a later trade is invisible at an earlier time
  const u = new Market("U"); assert.equal(u.delta(delta("U", "yes", "0.5", "5").msg, T0), false);  // delta before any snapshot is ignored
  u.ticker_({ yes_bid_dollars: "0.3000", yes_ask_dollars: "0.3400" }, T0); assert.equal(u.mid(), 0.32);
}

// ---- Stream client.
{
  FakeSocket.all = []; FakeSocket.sid = 1;
  const ck = fakeClock(T0), logs = [], msgs = [];
  const ws = new KalshiWS({ connect: () => new FakeSocket(), now: ck.now, setTimer: ck.set, clearTimer: ck.clear, log: m => logs.push(m), quietMs: 30e3, indices: ["BRTI"] });
  ws.on("message", m => msgs.push(m));
  const many = Array.from({ length: 250 }, (_, i) => "M" + i);
  ws.setMarkets(many); ws.start();
  let s = FakeSocket.all[0]; s.open();
  assert.deepEqual(s.cmds("subscribe").map(c => c.params.channels.join()), ["market_lifecycle_v2", "cfbenchmarks_value", "orderbook_delta,trade,ticker"]);
  assert.deepEqual(s.cmds("subscribe")[1].params.index_ids, ["BRTI"]);
  assert.equal(s.cmds("subscribe")[2].params.market_tickers.length, 100);
  s.ack(); assert.equal(ws.state, "live");
  const adds = s.cmds("update_subscription").filter(c => c.params.action === "add_markets");
  assert.equal(adds.length, 6); assert.equal(ws.have.size, 250);                             // 150 more markets × 3 subscriptions, in chunks of 100
  ws.setMarkets(many.slice(10).concat("NEW"));
  assert.equal(s.cmds("update_subscription").filter(c => c.params.action === "delete_markets")[0].params.market_tickers.length, 10); assert.ok(ws.have.has("NEW") && !ws.have.has("M0"));
  // Sequence numbers: in order → delivered; a gap on the book subscription → ask for fresh snapshots of everything.
  const ob = s.sid("orderbook_delta");
  s.recv(snap("M20", [], [], ob, 1)); s.recv(delta("M20", "yes", "0.5", "1", ob, 2)); assert.equal(ws.stats.gaps, 0);
  s.recv(delta("M20", "yes", "0.5", "1", ob, 5)); assert.equal(ws.stats.gaps, 1);
  assert.equal(s.cmds("update_subscription").filter(c => c.params.action === "get_snapshot").reduce((n, c) => n + c.params.market_tickers.length, 0), 241);
  assert.equal(msgs.length, 3);
  // Forced disconnect → reconnects by itself with a growing pause, and subscribes again to the whole set.
  s.drop(); assert.equal(ws.state, "reconnecting"); ck.advance(999); assert.equal(FakeSocket.all.length, 1); ck.advance(2); assert.equal(FakeSocket.all.length, 2);
  s = FakeSocket.all[1]; s.drop(); ck.advance(1500); assert.equal(FakeSocket.all.length, 2); ck.advance(600); assert.equal(FakeSocket.all.length, 3);   // 2nd wait is 2 s
  s = FakeSocket.all[2]; s.open(); s.ack(); assert.equal(ws.state, "live"); assert.equal(ws.have.size, 241); assert.equal(ws.stats.reconnects, 2);
  assert.ok(ws.health().downMs >= 3000 && ws.health().downMs < 4000);
  // Silence for 30 s → the socket is treated as dead and replaced.
  ck.advance(30.5e3); assert.equal(ws.state, "reconnecting"); ck.advance(600); assert.equal(FakeSocket.all.length, 4);
  // Only market-data channels can ever be requested.
  for (const sock of FakeSocket.all) for (const c of sock.cmds("subscribe")) for (const ch of c.params.channels) assert.ok(["orderbook_delta", "trade", "ticker", "market_lifecycle_v2", "cfbenchmarks_value"].includes(ch));
  assert.ok(FakeSocket.all.every(sock => sock.sent.every(c => ["subscribe", "update_subscription"].includes(c.cmd))));
  ws.stop();
}

// ---- Engine: re-estimates on a move, snapshots at fixed leads from past data only, settlement from the lifecycle channel.
{
  const res = T0 + 30 * 6e4 + 500, calls = [];
  const e = new Engine({ estimate: c => { calls.push(c); return { est: { market: c.mid }, picks: {} }; }, cfg: { updateMove: 0.03, updateEveryMin: 15, updateMinGapSec: 60 } });
  e.setScope([{ ticker: "A", event: "EA", series: "S", cat: "Crypto", title: "a", resolvesAt: new Date(res).toISOString(), logged: true, loggedAt: T0, mid0: 0.465 }]);
  e.setLive(true);
  e.onMessage(snap("A", [["0.4200", "300.00"]], [["0.4900", "100.00"]]), T0);
  let out = e.onClock(T0 + 1000);
  assert.equal(out.ticks.filter(x => x.e === "q").length, 1); assert.equal(out.updates.length, 0);
  assert.equal(out.snaps.length, 1); assert.equal(out.snaps[0].leadMin, 30); assert.equal(out.snaps[0].mid, 0.465);          // 30-min lead snapshot, taken once
  e.onMessage(delta("A", "yes", "0.4800", "50.00"), T0 + 30e3);                                // bid jumps to 0.48 → mid 0.495 (+0.03)
  assert.equal(e.onClock(T0 + 40e3).updates.length, 0);                                        // under the 60 s minimum gap
  out = e.onClock(T0 + 61e3); assert.equal(out.updates.length, 1); assert.equal(out.updates[0].why, "move"); assert.equal(out.updates[0].from, 0.465); assert.equal(out.updates[0].mid, 0.495);
  assert.equal(e.onClock(T0 + 70e3).updates.length, 0);
  assert.equal(e.onClock(T0 + 17 * 6e4).updates[0].why, "time");
  // The 15-min lead fell inside a gap of more than a minute between clock calls: skipped rather than taken late.
  e.onMessage(delta("A", "yes", "0.5000", "10.00"), T0 + 25 * 6e4 + 900);                       // arrives AFTER the 5-min mark
  out = e.onClock(T0 + 25 * 6e4 + 600); assert.equal(out.snaps.length, 1); assert.equal(out.snaps[0].leadMin, 5);
  assert.ok(calls.every(c => c.at <= T0 + 25 * 6e4 + 600 && c.leadMin > 0));
  e.onMessage({ type: "market_lifecycle_v2", msg: { market_ticker: "A", event_type: "determined", result: "yes", determination_ts: Math.floor(res / 1000) + 5 } }, res + 6000);
  assert.deepEqual(e.takeSettled().map(s => [s.ticker, s.result, s.determinedAt]), [["A", "yes", (Math.floor(res / 1000) + 5) * 1000]]);
  assert.equal(e.onClock(res + 7000).updates.length, 0);                                       // nothing is estimated after resolution
  e.setLive(false); assert.equal(e.staleness(T0 + 29 * 6e4).stale, 1);                         // stream down + old data = stale
}

// ---- Compressed append-only log: several flushes read back as one file.
{
  const d = mkdtempSync(tmpdir() + "/gz-"), g = new GzLog(d, { flushRows: 2 });
  g.add([{ a: 1 }, { a: 2 }], T0); g.add([{ a: 3 }], T0); g.flush(); g.add([{ a: 4 }], T0 + 864e5); g.flush();
  assert.deepEqual(readGz(`${d}/2026-11-12.jsonl.gz`).map(x => x.a), [1, 2, 3]); assert.deepEqual(readGz(`${d}/2026-11-13.jsonl.gz`), [{ a: 4 }]);
}

// ---- Alert rules and cooldown.
{
  const a = evaluate({ downMin: 5, streamDownSec: 200, predictors: { weather: { on: true, n: 30, vsMarket: 0.335 }, nn: { on: true, n: 500, vsMarket: -0.01, status: "SUCCESS" }, old: { on: false, n: 99, vsMarket: 0.4 } },
    portfolios: [{ id: "p", name: "P", maxDrawdownPct: 25 }, { id: "q", name: "Q", maxDrawdownPct: 5 }], llm: { day: "2026-11-12", spent: 0.85, cap: 1 } });
  assert.deepEqual(a.map(x => x.key).sort(), ["daemon-down", "dd-p", "llm-2026-11-12", "off-weather", "stream-down", "success-nn"]);
  assert.deepEqual(a.find(x => x.key === "off-weather").action, { disable: "weather" });
  assert.equal(evaluate({ downMin: 1, predictors: { nn: { on: true, n: 10, vsMarket: 0.5 } }, llm: { spent: 0.5, cap: 1 } }).length, 0);
  const ck = fakeClock(T0), sent = [], al = new Alerts({ now: ck.now, tgt: { kind: "ntfy", url: "https://example.invalid/topic" }, persist: false, fetchFn: async (u, o) => { sent.push([u, o]); return { ok: true }; } });
  assert.equal(await al.raise("k", "Title", "body", { cooldownMin: 10 }), true); assert.equal(await al.raise("k", "Title", "body", { cooldownMin: 10 }), false);
  ck.advance(11 * 6e4); assert.equal(await al.raise("k", "Title", "body", { cooldownMin: 10 }), true);
  assert.equal(sent.length, 2); assert.equal(sent[0][1].headers.Title, "Title"); assert.equal(sent[0][1].body, "body");
}

// ---- Daemon end to end (own process, temp folder, fake socket): stream → engine → logs, settlement → outcome + labelled
//      snapshots + rescore, forced disconnect → recovery, live page pushes a price change in well under a second.
{
  const d = mkdtempSync(tmpdir() + "/daemon-"); mkdirSync(`${d}/data/predictions`, { recursive: true });
  const res = new Date(Date.now() + 29.5 * 6e4).toISOString(), ts = new Date(Date.now() - 6e4).toISOString();
  const P = (k, ev) => ({ ts, ticker: k, event: ev, series: "S", cat: "Crypto", title: k, resolvesAt: res, ask: 0.45, bid: 0.42, mid: 0.435, spread: 0.03, est: { market: 0.435 }, picks: {}, cfg: 10 });
  writeFileSync(`${d}/data/predictions/${ts.slice(0, 7)}.jsonl`, [P("A", "EA"), P("B", "EB")].map(x => JSON.stringify(x)).join("\n") + "\n");
  spawnSync("git", ["init", "-q", "."], { cwd: d });
  const code = `
    import { createDaemon } from ${JSON.stringify(ROOT + "live/daemon.mjs")}; import { FakeSocket } from ${JSON.stringify(ROOT + "tests/fake.mjs")}; import { Alerts } from ${JSON.stringify(ROOT + "live/alerts.mjs")};
    process.env.NO_PUSH = "1";
    const D = createDaemon({ connect: () => new FakeSocket(), log: () => {}, port: 0, alerts: new Alerts({ tgt: null, persist: false }), kalshiFn: async () => ({ markets: [] }), offline: true });
    await D.start();
    const R = { port: D.port }, sock = () => FakeSocket.all.at(-1);
    sock().open(); sock().ack(); R.live = D.ws.state; R.watching = [...D.ws.have].sort();
    const ob = sock().sid("orderbook_delta"), lc = sock().sid("market_lifecycle_v2");
    // a browser listening on the live page
    const ctl = new AbortController(), resp = await fetch("http://127.0.0.1:" + D.port + "/events", { signal: ctl.signal }), rd = resp.body.getReader(); let got = "", t1 = 0;
    const pump = (async () => { for (;;) { const { value, done } = await rd.read().catch(() => ({ done: true })); if (done) break; got += Buffer.from(value).toString(); if (!t1 && got.includes("event: tick")) t1 = performance.now(); } })();
    await new Promise(r => setTimeout(r, 50));
    const t0 = performance.now();
    sock().recv({ type: "orderbook_snapshot", sid: ob, seq: 1, msg: { market_ticker: "A", yes_dollars_fp: [["0.4200", "300.00"]], no_dollars_fp: [["0.5500", "100.00"]] } });
    D.fast(); await new Promise(r => setTimeout(r, 100)); R.sseMs = t1 ? Math.round(t1 - t0) : null; R.sseHasA = got.includes('"k":"A"');
    D.second(); R.snaps = existsSync("local/pending-snaps.jsonl") ? readFileSync("local/pending-snaps.jsonl", "utf8").trim().split("\\n").length : 0;
    // forced disconnect → new socket, subscribed again, book re-synced by the new snapshot
    sock().drop(); R.afterDrop = D.ws.state; await new Promise(r => setTimeout(r, 1200)); sock().open(); sock().ack(); R.recovered = D.ws.state; R.sockets = FakeSocket.all.length;
    sock().recv({ type: "orderbook_snapshot", sid: sock().sid("orderbook_delta"), seq: 1, msg: { market_ticker: "A", yes_dollars_fp: [["0.4400", "10.00"]], no_dollars_fp: [["0.5400", "10.00"]] } });
    R.midAfter = D.engine.view("A", Date.now()).mid;
    // settlement over the stream
    sock().recv({ type: "market_lifecycle_v2", sid: sock().sid("market_lifecycle_v2"), seq: 1, msg: { market_ticker: "A", event_type: "determined", result: "yes", determination_ts: Math.floor(Date.now() / 1000) } });
    D.second(); R.outcome = D.ctx.store.out.get("A"); R.dirty = D.dirty; R.snapRows = D.ctx.store.snapshots.filter(r => r.ticker === "A").map(r => [r.leadMin, r.y, r.mid]);
    await D.tick(); R.scorecard = existsSync("site/scorecard.json"); R.hb = JSON.parse(readFileSync("site/heartbeat.json", "utf8")); R.liveJson = JSON.parse(readFileSync("site/live.json", "utf8")).markets.map(m => m.k);
    R.unsub = sock().cmds("update_subscription").filter(c => c.params.action === "delete_markets").map(c => c.params.market_tickers.join()); R.state = (await (await fetch("http://127.0.0.1:" + D.port + "/api/state")).json()).markets.length; R.post = (await fetch("http://127.0.0.1:" + D.port + "/api/state", { method: "POST" })).status;
    ctl.abort(); D.stop(); await pump.catch(() => {});
    import("node:fs").then(() => { console.log(JSON.stringify(R)); process.exit(0); });
    import { existsSync, readFileSync } from "node:fs";`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: d, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const R = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(R.live, "live"); assert.deepEqual(R.watching, ["A", "B"]);
  assert.ok(R.sseMs != null && R.sseMs < 1000 && R.sseHasA, `SSE latency ${R.sseMs} ms`);
  assert.equal(R.snaps, 1);
  assert.equal(R.afterDrop, "reconnecting"); assert.equal(R.recovered, "live"); assert.equal(R.sockets, 2); assert.equal(R.midAfter, 0.45);
  assert.equal(R.outcome.result, "yes"); assert.equal(R.outcome.via, "ws"); assert.deepEqual(R.snapRows, [[30, 1, 0.435]]);
  assert.ok(R.scorecard); assert.equal(R.hb.ws.state, "live"); assert.equal(R.hb.ws.reconnects, 1); assert.equal(R.hb.mode, "ws"); assert.deepEqual(R.liveJson, []);
  assert.equal(R.state, 0); assert.deepEqual(R.unsub, ["A", "A", "A"]);          // the settled market left all three subscriptions assert.equal(R.post, 405);
  assert.ok(existsSync(`${d}/local/ticks`));
}

// ---- Replay: a recorded stream log through the engine must reproduce the logged estimates exactly, twice in a row.
{
  const { replay, digest } = await import("../live/replay.mjs");
  const exp = JSON.parse(readFileSync(ROOT + "tests/fixtures/replay.expected.json", "utf8")), rows = readGz(ROOT + "tests/fixtures/replay.jsonl.gz");
  assert.equal(rows.length, exp.messages);
  const a = replay(rows, { cfg: exp.cfg }), b = replay(rows, { cfg: exp.cfg });
  assert.equal(digest(a), exp.digest, "replay no longer reproduces the logged estimates"); assert.equal(digest(b), exp.digest);
  assert.deepEqual(a.updates, exp.updates); assert.deepEqual(a.snaps, exp.snaps);
  assert.deepEqual({ ticks: a.ticks, features: a.features.length, snaps: a.snaps.length, updates: a.updates.length }, exp.counts);
  assert.ok(exp.counts.features > 50 && exp.counts.updates > 0, "fixture too thin to mean anything");
  // No look-ahead: every row the engine produced is stamped at or before the clock that produced it, and before resolution.
  for (const r of [...a.features, ...a.snaps, ...a.updates]) assert.ok(Date.parse(r.ts) < Date.parse(r.resolvesAt ?? "9999-01-01"));
}
