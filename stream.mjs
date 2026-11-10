// 24/7 streamer — run on your own computer:   node stream.mjs
// Needs Node 20+, git, and a clone of this repo you can push to (your normal GitHub login). Ctrl+C stops it.
//
// Every minute:  live bid/ask for every open market the agent watches (one public Kalshi call) → minute price log on this
//                computer (local/ticks/, not pushed) + current prices in data/live.json; collect new outcomes; when new
//                outcomes arrived, retrain the neural network right away and rescore everything.
// Storage:       old months move to data/archive/ (verified gzip); an uncompressed copy of everything stays in local/archive/.
// Every 10 min:  the full scan (new predictions, backtest, focus prices, Gemini, dashboard) — the same steps as cycle.sh.
// Every 5 min:   commit + push. A heartbeat (data/stream.json) tells the cloud schedule to step aside while this runs.
// Public data only: no Kalshi account, no keys, nothing that can trade.
// Options: STREAM_MINUTES=n (stop after n minutes), NO_PUSH=1 (never commit/push), GEMINI_API_KEY (optional, your own).
import { spawnSync } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { kalshi, readJsonl, writeJson, predictionFiles, r4, sleep } from "./lib.mjs";

const NO_PUSH = process.env.NO_PUSH === "1", LIMIT = +process.env.STREAM_MINUTES || Infinity, started = Date.now();
const node = (f, env = {}) => { const r = spawnSync(process.execPath, [f], { stdio: "pipe", encoding: "utf8", env: { ...process.env, ...env } });
  const out = (r.stdout || "").trim().split("\n").pop(); if (r.status !== 0) log(`${f} failed: ${(r.stderr || "").trim().split("\n").pop()}`); return { ok: r.status === 0, out }; };
const nodeArgs = (f, args) => { const r = spawnSync(process.execPath, [f, ...args], { stdio: "pipe", encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "").trim().split("\n").pop() }; };
const git = (...a) => spawnSync("git", a, { stdio: "pipe", encoding: "utf8" });
const log = m => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);
const outcomesCount = () => readJsonl("data/outcomes.jsonl").length;
let lastFull = 0, lastPush = Date.now(), minute = 0, stop = false;
process.on("SIGINT", () => { stop = true; log("stopping after this step…"); });

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
  const at = new Date(now).toISOString(), day = at.slice(0, 10);
  mkdirSync("local/ticks", { recursive: true });
  if (live.length) appendFileSync(`local/ticks/${day}.jsonl`, live.map(x => JSON.stringify({ t: at, k: x.ticker, b: x.bid, a: x.ask })).join("\n") + "\n");
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
save("final"); log("streamer stopped");
