// Replay: feed a recorded stream log through the engine with the recorded clock and collect what it produces.
// Same code path as the live daemon (Engine), no network, no wall clock — so the result must be identical every time.
//   node live/replay.mjs local/raw/2026-11-13.jsonl.gz     replays a day recorded with RECORD_RAW=1 and compares the
//                                                           re-estimates with the rows the daemon logged in data/updates/
import { createHash } from "node:crypto";
import { Engine } from "./engine.mjs";
import { readGz } from "./ticklog.mjs";

// rows: [{ t, m }] (m = stream message, or { type: "_scope", list } / { type: "_state", live }). Clock ticks every second between messages.
export function replay(rows, { estimate = c => ({ est: { market: c.mid }, picks: {} }), cfg = {}, scope = null, until = null } = {}) {
  const e = new Engine({ estimate, cfg }), out = { ticks: 0, features: [], snaps: [], updates: [], settled: [] };
  if (scope) e.setScope(scope);
  if (!rows.length) return out;
  let clock = Math.floor(rows[0].t / 1000) * 1000;
  const run = to => { for (; clock <= to; clock += 1000) { const o = e.onClock(clock); out.ticks += o.ticks.length; out.features.push(...o.features); out.snaps.push(...o.snaps); out.updates.push(...o.updates); out.settled.push(...e.takeSettled()); } };
  for (const { t, m } of rows) { run(t - 1); if (m.type === "_scope") e.setScope(m.list); else e.onMessage(m, t); }
  run(until ?? rows.at(-1).t + 1000);
  return out;
}
export const digest = o => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2]; if (!file) { console.log("usage: node live/replay.mjs local/raw/YYYY-MM-DD.jsonl.gz"); process.exit(1); }
  const { readJsonl, config } = await import("../lib.mjs"), { Store } = await import("../core/store.mjs");
  const rows = readGz(file), s = new Store(); s.refresh();
  const scope = s.preds.map(p => ({ ticker: p.ticker, event: p.event, series: p.series, cat: p.cat, title: p.title, resolvesAt: p.resolvesAt, logged: true, loggedAt: Date.parse(p.ts), mid0: p.mid }));
  const r = replay(rows, { scope, cfg: config.live }), day = file.match(/(\d{4}-\d{2})-\d{2}/)?.[1];
  const logged = Object.fromEntries(readJsonl(`data/updates/${day}.jsonl`).map(u => [`${u.ticker}|${u.ts}`, u]));
  let same = 0, diff = 0, missing = 0;
  for (const u of r.updates) { const l = logged[`${u.ticker}|${u.ts}`]; if (!l) missing++; else if (l.mid === u.mid && l.bid === u.bid && l.ask === u.ask) same++; else diff++; }
  console.log(`replayed ${rows.length} messages → ${r.features.length} feature rows, ${r.snaps.length} snapshots, ${r.updates.length} re-estimates, ${r.settled.length} settlements (digest ${digest(r)})`);
  console.log(`vs logged re-estimates: ${same} identical prices, ${diff} different, ${missing} not in the log (scope or timing differed)`);
  process.exit(diff ? 1 : 0);
}
