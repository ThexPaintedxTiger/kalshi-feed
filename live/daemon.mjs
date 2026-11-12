// Live daemon (owner's computer). Step 1 version: one long-running process, in-process steps, public REST polling.
// The authenticated WebSocket layer, localhost live API and alerts are added on top of this loop (see docs/architecture.md).
import { hostname } from "node:os";
import { makeCtx } from "../core/ctx.mjs";
import { cycle, derive, perf } from "../cycle.mjs";
import * as resolve from "../resolve.mjs";
import { pushMain, pushSite } from "../publish.mjs";
import { config, sleep } from "../lib.mjs";

const LIMIT = +process.env.STREAM_MINUTES || Infinity, started = Date.now(), PUB = config.publish;
const ctx = makeCtx({ log: m => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`) });
ctx.host = "daemon";
let stop = false, lastFull = 0, lastMain = Date.now(), lastSite = 0, minute = 0;
process.on("SIGINT", () => { if (stop) process.exit(0); stop = true; ctx.log("stopping after this step… (Ctrl+C again to stop now)"); });
ctx.log(`live daemon started on ${hostname()} (${process.env.NO_PUSH === "1" ? "NO_PUSH: local only" : "pushing logs to main, site to the site branch"})`);
while (!stop && Date.now() - started < LIMIT * 6e4) {
  const t0 = Date.now(); minute++;
  ctx.emit("heartbeat", { at: new Date().toISOString(), host: hostname(), startedAt: new Date(started).toISOString(), minute, mode: "rest" });
  try {
    if (Date.now() - lastFull >= 10 * 6e4) { lastFull = Date.now(); const p = await cycle(ctx, { mirror: true }); ctx.log(`full cycle ${p.ms} ms, ${p.rssMB} MB`); }
    else { const before = ctx.store.out.size, t = performance.now(); ctx.timings = []; await ctx.step("resolve", resolve.run);
      if (ctx.store.out.size > before) { await derive(ctx, { full: false }); perf(ctx, "settle", t); } }
  } catch (e) { ctx.log(`error: ${e.message} — continuing`); }
  if (Date.now() - lastSite >= PUB.siteEveryMinutes * 6e4) { lastSite = Date.now(); const r = pushSite(`minute ${minute}`); if (/FAILED/.test(r)) ctx.log(r); }
  if (Date.now() - lastMain >= PUB.mainEveryMinutes * 6e4) { lastMain = Date.now(); ctx.log(pushMain(`daemon minute ${minute}`)); }
  const wait = 6e4 - (Date.now() - t0); if (wait > 0 && !stop) await sleep(wait);
}
ctx.log(pushMain("daemon stopping")); pushSite("daemon stopping"); ctx.log("daemon stopped");
