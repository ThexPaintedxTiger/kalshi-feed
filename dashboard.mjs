// Builds dashboard.json: one small file with everything dashboard.html shows (agent pipeline, skills,
// simulated trades, data, goals). Code only, no API or AI calls.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { config, readJsonl, readJson, writeJson, fee, r4, marketUrl, predictionRows } from "./lib.mjs";

const now = Date.now();
const preds = predictionRows();
const out = Object.fromEntries(readJsonl("data/outcomes.jsonl").map(o => [o.ticker, o]));
const runs = readJsonl("data/runs.jsonl");
const progress = readJson("progress.json", {}), scorecard = readJson("scorecard.json", {}), bets = readJson("bets.json", {});

const catMap = readJson("data/series.json", { map: {} }).map;
for (const p of preds) if (!p.cat) p.cat = catMap[p.series] || ""; // fill categories learned after the row was logged (display only)
const outcome = p => { const o = out[p.ticker]; return o ? o.result : Date.parse(p.resolvesAt) < now ? "awaiting" : "open"; };
const slim = p => ({ ts: p.ts, ticker: p.ticker, title: p.title, cat: p.cat, resolvesAt: p.resolvesAt, ask: p.ask, bid: p.bid,
  mid: p.mid, est: p.est, outcome: outcome(p), url: marketUrl(p.series) });

// Simulated trades: one row per predictor pick. Outcome and P&L after fees once resolved.
const trades = [];
for (const p of preds) for (const [who, pk] of Object.entries(p.picks || {})) {
  const o = outcome(p), y = o === "yes" ? 1 : o === "no" ? 0 : null;
  const win = y == null ? null : pk.side === "yes" ? y : 1 - y;
  trades.push({ ts: p.ts, predictor: who, ticker: p.ticker, title: p.title, cat: p.cat, side: pk.side, cost: pk.cost, ev: pk.ev,
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
for (const p of preds) { const c = (cats[p.cat || "Other"] ||= { logged: 0, resolved: 0 }); c.logged++; if (out[p.ticker]?.result === "yes" || out[p.ticker]?.result === "no") c.resolved++; }

writeJson("dashboard.json", {
  generated: new Date(now).toISOString(),
  config: { version: config.version, scan: config.scan, predictors: config.predictors, picks: config.picks, goals: config.goals, backtest: config.backtest, paper: config.paper, live: config.live },
  progress, scorecard: { resolved: scorecard.resolved, predictions: scorecard.predictions, excludedLeakage: scorecard.excludedLeakage,
    events: scorecard.events, predictors: scorecard.predictors, byCategory: scorecard.byCategory },
  totals: { predictions: preds.length, outcomes: Object.keys(out).length, trades: trades.length, runs: runs.length },
  categories: cats,
  runs: runs.slice(-144),
  predictions: preds.slice(-150).reverse().map(slim),
  trades: trades.slice(-150).reverse(),
  gemini: { updated: bets.picksUpdated || null, agents: bets.picksAgents || [], picks: (bets.picks || []).slice(0, 10),
    feedUpdated: bets.updated || null, liquid: bets.liquid || 0, events: bets.events || 0 },
  skills,
  backtest: (() => { const b = readJson("backtest-scorecard.json", null); return b && { resolved: b.resolved, events: b.events, window: b.window, predictors: b.predictors }; })(),
  memory: (() => { const m = readJson("data/memory/series.json", { series: {} }); return { samples: m.samples || 0, series: Object.keys(m.series).length,
    top: Object.entries(m.series).sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, v]) => ({ series: k, ...v })) }; })(),
  mcpTools: ["get_status", "get_scorecard", "search_predictions", "recall_series", "list_skills"],
  nn: (() => { const m = readJson("data/nn/model.json", null); if (!m) return null;
    const c = m.holdout?.curve || [], step = Math.ceil(c.length / 120) || 1;
    return { ...m, holdout: m.holdout && { ...m.holdout, curve: c.filter((_, i) => i % step === 0 || i === c.length - 1) },
      log: readJsonl("data/nn/train-log.jsonl").slice(-48) }; })(),
  paper: readJson("data/paper/portfolios.json", null),
  status: readJson("status.json", null),
  external: readJson("data/external/last.json", null),
  stream: readJson("data/stream.json", null),
  storage: readJson("data/storage.json", null),
  live: (() => { const l = readJson("data/live.json", null); return l && { at: l.at, n: l.markets.length }; })(),
  briefings: readJsonl("data/briefing.jsonl").slice(-6).reverse(),
  focus: readJson("data/focus.json", null),
});
console.log(`dashboard.json: ${preds.length} predictions, ${trades.length} simulated trades, ${skills.length} skills`);
