// Builds dashboard.json: one small file with everything dashboard.html shows (agent pipeline, skills,
// simulated trades, data, goals). Code only, no API or AI calls.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { config, readJsonl, readJson, fee, r4, marketUrl } from "./lib.mjs";

export function run(ctx) {
const now = Date.now(), st = ctx.store, preds = st.preds, out = Object.fromEntries(st.out), runs = st.runs;
const progress = ctx.get("progress") || {}, scorecard = ctx.get("scorecard") || {};
const catMap = readJson("data/series.json", { map: {} }).map;
const catOf = p => p.cat || catMap[p.series] || "";
const outcome = p => { const o = out[p.ticker]; return o ? o.result : Date.parse(p.resolvesAt) < now ? "awaiting" : "open"; };
const slim = p => ({ ts: p.ts, ticker: p.ticker, title: p.title, cat: catOf(p), resolvesAt: p.resolvesAt, ask: p.ask, bid: p.bid,
  mid: p.mid, est: p.est, outcome: outcome(p), url: marketUrl(p.series) });

// Simulated trades: one row per predictor pick. Outcome and P&L after fees once resolved.
const trades = [];
for (const p of preds) for (const [who, pk] of Object.entries(p.picks || {})) {
  const o = outcome(p), y = o === "yes" ? 1 : o === "no" ? 0 : null;
  const win = y == null ? null : pk.side === "yes" ? y : 1 - y;
  trades.push({ ts: p.ts, predictor: who, ticker: p.ticker, title: p.title, cat: catOf(p), side: pk.side, cost: pk.cost, ev: pk.ev,
    fee: fee(pk.cost), resolvesAt: p.resolvesAt, outcome: o, pnl: win == null ? null : r4(win - pk.cost - fee(pk.cost)) });
}

// Skills from .claude/skills/*/SKILL.md front matter.
const skills = [];
const sdir = ".claude/skills";
if (existsSync(sdir)) for (const name of readdirSync(sdir).sort()) {
  const f = `${sdir}/${name}/SKILL.md`; if (!existsSync(f)) continue;
  const fm = (readFileSync(f, "utf8").split("---")[1] || "");
  const get = k => { const m = fm.match(new RegExp(`^${k}:\\s*(.*)$`, "m")); if (!m) return ""; try { return m[1].startsWith('"') ? JSON.parse(m[1]) : m[1]; } catch { return m[1]; } };
  skills.push({ name: get("name") || name, description: get("description"), path: f });
}

const cats = {};
for (const p of preds) { const c = (cats[catOf(p) || "Other"] ||= { logged: 0, resolved: 0 }); c.logged++; if (out[p.ticker]?.result === "yes" || out[p.ticker]?.result === "no") c.resolved++; }

ctx.emit("dashboard", {
  generated: new Date(now).toISOString(),
  config: { version: config.version, scan: config.scan, predictors: config.predictors, picks: config.picks, goals: config.goals, backtest: config.backtest, paper: config.paper, live: config.live },
  progress, scorecard: { resolved: scorecard.resolved, predictions: scorecard.predictions, excludedLeakage: scorecard.excludedLeakage,
    events: scorecard.events, predictors: scorecard.predictors, byCategory: scorecard.byCategory },
  totals: { predictions: preds.length, outcomes: Object.keys(out).length, trades: trades.length, runs: runs.length },
  categories: cats,
  runs: runs.slice(-144),
  predictions: preds.slice(-150).reverse().map(slim),
  trades: trades.slice(-150).reverse(),
  gemini: { updated: null, agents: [], picks: [], feedUpdated: null, liquid: 0, events: 0 },   // removed in v2 (kept empty for the old page)
  skills,
  backtest: (() => { const b = ctx.get("backtest-scorecard"); return b && { resolved: b.resolved, events: b.events, window: b.window, predictors: b.predictors }; })(),
  memory: (() => { const m = ctx.get("memory", "state") || { series: {} }; return { samples: m.samples || 0, series: Object.keys(m.series).length,
    top: Object.entries(m.series).sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, v]) => ({ series: k, ...v })) }; })(),
  mcpTools: ["get_status", "get_scorecard", "search_predictions", "recall_series", "list_skills"],
  nn: (() => { const m = ctx.get("nn-model", "state"); return m ? { ...m, log: readJsonl("data/nn/train-log.jsonl").slice(-48) } : null; })(),
  paper: ctx.get("paper"),
  status: ctx.get("status"),
  external: ctx.get("external", "state"),
  stream: ctx.get("heartbeat"),
  storage: ctx.get("storage"),
  live: (() => { const l = ctx.get("live"); return l && { at: l.at, n: (l.markets || []).length }; })(),
  briefings: readJsonl("data/briefing.jsonl").slice(-6).reverse(),
  focus: null, perf: ctx.perf || null,
});
return (`dashboard.json: ${preds.length} predictions, ${trades.length} simulated trades, ${skills.length} skills`);
}
if (import.meta.url === `file://${process.argv[1]}`) { const { makeCtx } = await import("./core/ctx.mjs"); console.log(run(makeCtx())); }
