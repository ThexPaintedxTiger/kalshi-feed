// 24/7 streamer — run on your own computer:   node stream.mjs
// Needs Node 20+, git, and a clone of this repo you can push to (your normal GitHub login). Ctrl+C stops it.
//
// Every minute:  live bid/ask for every open market the agent watches (one public Kalshi call) → minute price log on this
//                computer (local/ticks/, not pushed) + current prices in data/live.json; collect new outcomes; when new
//                outcomes arrived, retrain the neural network right away and rescore everything.
// Storage:       old months move to data/archive/ (verified gzip); an uncompressed copy of everything stays in local/archive/.
// Every 10 min:  the full scan (new predictions, backtest, focus prices, Gemini, dashboard) — the same steps as cycle.sh.
// Every 5 min:   commit + push. A heartbeat (data/stream.json) tells the cloud schedule to step aside while this runs.
// Optional Kalshi key (private/, this computer only; see kalshi-auth.mjs): adds a live order book + trade stream over Kalshi's
// WebSocket; each minute tick then also records book imbalance and taker volume. Read-only allowlist; nothing can trade.
// Without the key files: public data only, exactly as before. NO_KEY=1 turns the keyed stream off.
// Options: STREAM_MINUTES=n (stop after n minutes), NO_PUSH=1 (never commit/push), GEMINI_API_KEY (optional, your own).
import { spawnSync } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { kalshi, readJsonl, writeJson, predictionFiles, r4, sleep } from "./lib.mjs";
import { hasKey, privateIgnored, openStream } from "./kalshi-auth.mjs";
import { bookImbalance, takerSide } from "./nnlib.mjs";

const NO_PUSH = process.env.NO_PUSH === "1", LIMIT = +process.env.STREAM_MINUTES || Infinity, started = Date.now();
const node = (f, env = {}) => { const r = spawnSync(process.execPath, [f], { stdio: "pipe", encoding: "utf8", env: { ...process.env, ...env } });
  const out = (r.stdout || "").trim().split("\n").pop(); if (r.status !== 0) log(`${f} failed: ${(r.stderr || "").trim().split("\n").pop()}`); return { ok: r.status === 0, out }; };
const nodeArgs = (f, args) => { const r = spawnSync(process.execPath, [f, ...args], { stdio: "pipe", encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "").trim().split("\n").pop() }; };
const git = (...a) => spawnSync("git", a, { stdio: "pipe", encoding: "utf8" });
const log = m => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);
const outcomesCount = () => readJsonl("data/outcomes.jsonl").length;
let lastFull = 0, lastPush = Date.now(), minute = 0, stop = false;
process.on("SIGINT", () => { stop = true; log("stopping after this step…"); });

// Keyed stream state: order book per market (price → contracts, YES bids and NO bids) and taker volume since the last tick.
const KEYED = process.env.NO_KEY !== "1" && hasKey() && privateIgnored();
const books = {}, flow = {}, seen = new Set(); let ws = null, wsKey = "", reported = 0;
const px = v => { const x = +v; return Math.round((x > 1 ? x / 100 : x) * 1e4) / 1e4; };           // cents or dollars → dollars
const lv = a => (a || []).map(([p, q]) => [px(p), +q]);
function onMsg(m) {
  if (m.type) seen.add(m.type);
  if (m.type === "error") log(`keyed stream error: ${JSON.stringify(m.msg || m).slice(0, 160)}`);
  const d = m.msg || {}, k = d.market_ticker; if (!k) return;
  if (m.type === "orderbook_snapshot") books[k] = { yes: new Map(lv(d.yes_dollars_fp ?? d.yes_dollars ?? d.yes)), no: new Map(lv(d.no_dollars_fp ?? d.no_dollars ?? d.no)) };
  else if (m.type === "orderbook_delta" && books[k]?.[d.side]) {
    const side = books[k][d.side], p = px(d.price_dollars ?? d.price), q = (side.get(p) || 0) + +(d.delta_fp ?? d.delta ?? 0);
    if (q > 0) side.set(p, q); else side.delete(p);
  } else if (m.type === "trade" && !d.is_block_trade) {
    const f = flow[k] ||= { y: 0, n: 0 }, c = +(d.count_fp ?? d.count) || 0, side = takerSide(d);
    if (side === "yes") f.y += c; else if (side === "no") f.n += c;
  }
}
function keyedFor(tickers) {                                                     // (re)subscribe when the watched set changes
  const key = [...tickers].sort().join(",");
  if (!KEYED || !tickers.length || (ws && key === wsKey)) return;
  ws?.close(); for (const k of Object.keys(books)) delete books[k];
  try { ws = openStream(tickers, onMsg, code => { ws = null; log(`keyed stream closed (${code}) — reconnecting next minute`); }); wsKey = key; }
  catch (e) { ws = null; log(`keyed stream not started: ${e.message}`); }
}

// Live prices for open, watched markets (logged predictions that haven't resolved). One batch call per 200 tickers.
async function tick() {
  const now = Date.now(), done = new Set(readJsonl("data/outcomes.jsonl").map(o => o.ticker));
  const open = [...new Map(predictionFiles().flatMap(f => readJsonl(f))
    .filter(p => !done.has(p.ticker) && Date.parse(p.resolvesAt) > now - 5 * 60e3).map(p => [p.ticker, p])).values()];
  const live = [];
  for (let i = 0; i < open.length; i += 200) {
    const j = await kalshi(`/markets?limit=1000&tickers=${open.slice(i, i + 200).map(p => encodeURIComponent(p.ticker)).join(",")}`);
    for (const m of j.markets || []) live.push({ ticker: m.ticker, bid: +m.yes_bid_dollars, ask: +m.yes_ask_dollars, last: +m.last_price_dollars, status: m.status });
    await sleep(200);
  }
  keyedFor(open.map(p => p.ticker));
  if (seen.size > reported) { reported = seen.size; log(`keyed stream receiving: ${[...seen].join(", ")} · books for ${Object.keys(books).length} markets`); }
  const at = new Date(now).toISOString(), day = at.slice(0, 10);
  const extra = k => { if (!ws) return {}; const b = books[k], f = flow[k] || { y: 0, n: 0 }; delete flow[k];
    return { im: b ? bookImbalance([...b.yes], [...b.no]) : null, ty: r4(f.y), tn: r4(f.n) }; };
  mkdirSync("local/ticks", { recursive: true });
  if (live.length) appendFileSync(`local/ticks/${day}.jsonl`, live.map(x => JSON.stringify({ t: at, k: x.ticker, b: x.bid, a: x.ask, ...extra(x.ticker) })).join("\n") + "\n");
  writeJson("data/live.json", { at, markets: live.map(x => ({ ...x, mid: r4((x.bid + x.ask) / 2) })) });
  return live.length;
}

function save(reason) {
  if (NO_PUSH) return;
  git("add", "-A", "data", "scorecard.json", "backtest-scorecard.json", "progress.json", "status.json", "dashboard.json", "bets.json", "history.json");
  if (git("diff", "--cached", "--quiet").status === 0) return;
  git("config", "merge.keep.driver", "true");
  git("commit", "-q", "-m", `Update Kalshi feed (24/7 streamer: ${reason})`);
  for (let i = 0; i < 3; i++) { if (git("pull", "--rebase", "-q").status === 0 && git("push", "-q").status === 0) { log("pushed"); return; } spawnSync(process.platform === "win32" ? "timeout" : "sleep", ["5"]); }
  log("push failed — will retry next time (check your git login / network)");
}

log(`24/7 streamer started${NO_PUSH ? " (NO_PUSH: local only)" : ""}. Ctrl+C to stop.`);
log(KEYED ? "keyed stream: on (order book + trades, read-only)" : hasKey() && !privateIgnored() ? "keyed stream: OFF — private/ is not git-ignored, key not used" : "keyed stream: off (no key files; public data only)");
if (!NO_PUSH) git("pull", "--rebase", "-q");
while (!stop && Date.now() - started < LIMIT * 6e4) {
  const t0 = Date.now(); minute++;
  writeJson("data/stream.json", { at: new Date().toISOString(), host: "local", startedAt: new Date(started).toISOString(), minute });
  try {
    if (Date.now() - lastFull >= 10 * 6e4) {                                     // full scan
      lastFull = Date.now();
      if (!node("test.mjs").ok) { log("tests failed — not running the pipeline; fix before continuing"); break; }
      const ar = node("archive.mjs"); if (!/nothing due/.test(ar.out)) log(ar.out.slice(0, 200));
      const before = outcomesCount();
      node("resolve.mjs");
      const fresh = outcomesCount() - before;
      log(node("snapshots.mjs").out.slice(0, 160));                                  // minute log → training rows for resolved markets
      for (const f of ["memory.mjs", "predict.mjs", "backtest.mjs", "nn.mjs", "score.mjs", "progress.mjs", "paper.mjs", "focus.mjs", "scan.mjs", "agents.mjs", "storage.mjs", "status.mjs", "dashboard.mjs"]) {
        const r = f === "storage.mjs" ? nodeArgs(f, ["--mirror"]) : node(f, f === "nn.mjs" && fresh > 0 ? { FORCE: "1" } : {});     // new outcomes → retrain now, not on the hourly timer
        if (["predict.mjs", "nn.mjs", "storage.mjs", "status.mjs"].includes(f) && r.out) log(r.out.slice(0, 160));
      }
    } else {                                                                     // minute: prices, outcomes, learn if new
      const n = await tick(), before = outcomesCount();
      node("resolve.mjs");
      const fresh = outcomesCount() - before;
      if (fresh > 0) {
        for (const f of ["snapshots.mjs", "memory.mjs"]) node(f);                 // new outcomes → their minute snapshots join training too
        const nn = node("nn.mjs", { FORCE: "1" });                                // retrain now: new outcomes to learn from
        for (const f of ["score.mjs", "progress.mjs", "paper.mjs", "status.mjs", "dashboard.mjs"]) node(f);
        log(`${n} live prices · ${fresh} new outcome(s) → retrained: ${nn.out.slice(0, 120)}`);
      } else log(`${n} live prices · no new outcomes (network unchanged)`);
    }
  } catch (e) { log(`error: ${e.message} — continuing next minute`); }
  if (Date.now() - lastPush >= 5 * 6e4) { save(`minute ${minute}`); lastPush = Date.now(); }
  const wait = 6e4 - (Date.now() - t0);
  if (wait > 0 && !stop) await sleep(wait);
}
ws?.close(); save("final"); log("streamer stopped");
