// Shared context for one process: the log store (loaded once), derived results passed between steps in memory,
// and where derived files go. site/ = published to the `site` branch (GitHub Pages); state/ = local caches.
// Neither is committed to main: main keeps code and append-only logs only.
import { config, readJson, writeJson } from "../lib.mjs";
import { Store } from "./store.mjs";
import { loadSamples, makeRecall } from "../memory.mjs";

export function makeCtx({ root = ".", store = null, log = console.log } = {}) {
  const ctx = { root, store: store || new Store(root), out: {}, cfg: config, log, timings: [] };
  ctx.store.refresh();
  const file = (name, dir) => `${root === "." ? "" : root + "/"}${dir}/${name}.json`;
  ctx.emit = (name, obj, dir = "site") => { ctx.out[name] = obj; writeJson(file(name, dir), obj); return obj; };
  ctx.get = (name, dir = "site") => ctx.out[name] ?? (ctx.out[name] = readJson(file(name, dir), null));
  let rc = null, rcV = -1;
  ctx.samples = () => { if (rcV !== ctx.store.version) { const s = loadSamples(ctx.store); rc = { s, recall: makeRecall(s) }; rcV = ctx.store.version; } return rc.s; };
  ctx.recall = (series, at) => { ctx.samples(); return rc.recall(series, at); };
  // Run one step, timing it. `need` steps throw; others log and continue.
  ctx.step = async (name, fn, { need = false } = {}) => {
    const t0 = performance.now();
    try { const r = await fn(ctx); ctx.timings.push({ name, ms: Math.round(performance.now() - t0), ok: true }); if (typeof r === "string") log(r); return r; }
    catch (e) { ctx.timings.push({ name, ms: Math.round(performance.now() - t0), ok: false, error: e.message }); log(`${name} failed: ${e.message}`); if (need) throw e; return null; }
  };
  return ctx;
}
export const isMain = meta => meta.url === `file://${process.argv[1]}`;
