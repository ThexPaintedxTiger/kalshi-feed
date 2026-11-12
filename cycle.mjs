// One full pipeline cycle in ONE process: logs are loaded once (core/store.mjs) and every step shares them in memory.
// Used by the cloud fallback (cycle.sh / feed.yml) and by `node cycle.mjs` on any machine. The live daemon
// (live/daemon.mjs) runs the same steps, event-driven. Required steps stop the cycle; the others log and continue.
import { appendFileSync, mkdirSync } from "node:fs";
import { makeCtx } from "./core/ctx.mjs";
import * as archive from "./archive.mjs";
import * as resolve from "./resolve.mjs";
import * as memory from "./memory.mjs";
import * as predict from "./predict.mjs";
import * as backtest from "./backtest.mjs";
import * as nn from "./nn.mjs";
import * as score from "./score.mjs";
import * as progress from "./progress.mjs";
import * as paper from "./paper.mjs";
import * as storage from "./storage.mjs";
import * as status from "./status.mjs";
import * as dashboard from "./dashboard.mjs";

// Rebuild every derived file from the logs in memory (no network). Cheap enough to run each minute.
export async function derive(ctx, { mirror = false, full = true } = {}) {
  await ctx.step("score", score.run, { need: true });
  await ctx.step("progress", progress.run, { need: true });
  if (full) { await ctx.step("memory", memory.run); await ctx.step("paper", paper.run, { need: true }); await ctx.step("storage", c => storage.run(c, { mirror })); }
  await ctx.step("status", status.run, { need: true });
  await ctx.step("dashboard", dashboard.run, { need: true });
}

export async function cycle(ctx, { force = false, mirror = false } = {}) {
  const t0 = performance.now(); ctx.timings = [];
  await ctx.step("archive", () => { const { moved, failed } = archive.run(); ctx.store.refresh(); return moved.length || failed.length ? `archive: moved ${moved.length}, failed ${failed.length}` : null; });
  await ctx.step("resolve", resolve.run, { need: true });
  if (!ctx.get("nn-model", "state")?.model) await ctx.step("nn (cold start)", c => nn.run(c, { force: true }));   // fresh clone: no cached model yet
  await ctx.step("predict", predict.run, { need: true });
  await ctx.step("backtest", c => backtest.run(c, { force }));
  await ctx.step("nn", c => nn.run(c, { force }));
  await derive(ctx, { mirror });
  return perf(ctx, "cycle", t0);
}
// Cycle time and memory, logged locally (state/perf.jsonl) and shown on the dashboard.
export function perf(ctx, kind, t0) {
  const m = process.memoryUsage(), row = { ts: new Date().toISOString(), kind, ms: Math.round(performance.now() - t0), rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576),
    steps: Object.fromEntries(ctx.timings.map(t => [t.name, t.ms])), failed: ctx.timings.filter(t => !t.ok).map(t => t.name) };
  mkdirSync("state", { recursive: true }); appendFileSync("state/perf.jsonl", JSON.stringify(row) + "\n");
  ctx.perf = row; return row;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = makeCtx(); ctx.host = process.env.GITHUB_ACTIONS ? "cloud" : "local";
  try { const p = await cycle(ctx, { force: process.env.FORCE === "1" }); await ctx.step("dashboard", dashboard.run); console.log(`cycle done in ${p.ms} ms, ${p.rssMB} MB${p.failed.length ? `, failed: ${p.failed.join(", ")}` : ""}`); }
  catch (e) { console.error(`cycle stopped: ${e.message}`); process.exit(1); }
}
