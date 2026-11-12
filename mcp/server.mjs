// Read-only MCP server for the Kalshi research agent. It exposes the agent's own files (progress, scorecards,
// predictions, memory, skills) as tools, so Claude (Desktop, Claude Code, any MCP client) can answer questions from
// real data. It never writes, never calls Kalshi, never trades. Your private/ trade report is NOT exposed.
// Run: node mcp/server.mjs  (stdio). Setup: docs/architecture.md → MCP.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl, allMonthFiles } from "../lib.mjs";
import { Rag, similarOutcomes } from "../rag.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);                                                      // lib.mjs reads paths relative to the repo
const p = f => join(ROOT, f);
const json = (f, d = null) => { try { return JSON.parse(readFileSync(p(f), "utf8")); } catch { return d; } };
// Every month of a log, hot + gzipped archive, oldest first (same reader as the pipeline).
const jsonl = kind => allMonthFiles(kind).flatMap(f => readJsonl(f));
const outcomes = () => Object.fromEntries(readJsonl("data/outcomes.jsonl").map(o => [o.ticker, o.result]));
const reply = obj => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });

const server = new McpServer({ name: "kalshi-agent", version: "2.0.0" });

server.registerTool("get_status", {
  title: "Agent status",
  description: "Goal status (SUCCESS/FAILURE/in progress), pipeline health and each predictor's status and recommendation, from the latest progress file. Start here for 'how is the agent doing'.",
  inputSchema: {},
}, async () => {
  const runs = existsSync(p("data/runs.jsonl")) ? readFileSync(p("data/runs.jsonl"), "utf8").trim().split("\n") : [];
  return reply({ progress: json("site/progress.json", {}), trade: json("site/status.json", {}).trade || null, lastRun: runs.length ? JSON.parse(runs[runs.length - 1]) : null });
});

server.registerTool("get_scorecard", {
  title: "Scorecard",
  description: "Accuracy (Brier, log loss vs the market price), calibration and simulated P&L per predictor. which='live' is the forward record (the one that counts); which='backtest' is past settled markets (supporting evidence only).",
  inputSchema: { which: z.enum(["live", "backtest"]).default("live") },
}, async ({ which }) => reply(json(which === "live" ? "site/scorecard.json" : "site/backtest-scorecard.json", { error: "not built yet: run node cycle.mjs or start the daemon" })));

server.registerTool("search_predictions", {
  title: "Search predictions",
  description: "Find logged predictions (live by default) by text in the market title, series ticker, category or outcome. Returns market price, each predictor's estimate, resolution time and outcome. Max 50 rows, newest first.",
  inputSchema: {
    query: z.string().optional().describe("words in the market title"),
    series: z.string().optional().describe("series ticker, e.g. KXBTCD"),
    category: z.string().optional().describe("e.g. Sports, Crypto, Financials"),
    outcome: z.enum(["yes", "no", "pending"]).optional(),
    source: z.enum(["live", "backtest"]).default("live"),
    limit: z.number().int().min(1).max(50).default(20),
  },
}, async ({ query, series, category, outcome, source, limit }) => {
  const out = outcomes();
  let rows = (source === "live" ? jsonl("predictions") : jsonl("backtest"))
    .map(r => ({ ...r, outcome: source === "live" ? (out[r.ticker] || "pending") : (r.y ? "yes" : "no") }));
  if (query) { const q = query.toLowerCase(); rows = rows.filter(r => r.title.toLowerCase().includes(q)); }
  if (series) rows = rows.filter(r => r.series === series.toUpperCase());
  if (category) rows = rows.filter(r => (r.cat || "").toLowerCase() === category.toLowerCase());
  if (outcome) rows = rows.filter(r => r.outcome === outcome);
  return reply({ total: rows.length, rows: rows.slice(-limit).reverse().map(r => ({ ts: r.ts, ticker: r.ticker, title: r.title, cat: r.cat,
    marketPrice: r.mid, estimates: r.est, picks: r.picks, resolvesAt: r.resolvesAt, outcome: r.outcome })) });
});

server.registerTool("recall_series", {
  title: "Series memory",
  description: "What the agent remembers about one Kalshi series: settled markets seen, YES rate, average price, bias (outcome − price) and market Brier, plus the latest settled examples. Use before discussing a market in that series.",
  inputSchema: { series: z.string().describe("series ticker, e.g. KXATPMATCH") },
}, async ({ series }) => {
  const s = series.toUpperCase(), mem = json("state/memory.json", { series: {} });
  const out = outcomes();
  const examples = [...jsonl("predictions").filter(r => r.series === s && out[r.ticker]).map(r => ({ ...r, y: out[r.ticker] === "yes" ? 1 : 0, src: "live" })),
    ...jsonl("backtest").filter(r => r.series === s).map(r => ({ ...r, src: "backtest" }))]
    .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 10).map(r => ({ src: r.src, ts: r.ts, title: r.title, marketPrice: r.mid, outcome: r.y ? "yes" : "no" }));
  return reply({ series: s, memory: mem.series[s] || null, examples, note: mem.note });
});

server.registerTool("list_skills", {
  title: "Project skills",
  description: "The Claude skills saved for this agent (.claude/skills) with what each does and when to use it.",
  inputSchema: {},
}, async () => {
  const d = p(".claude/skills");
  const skills = existsSync(d) ? readdirSync(d).filter(n => existsSync(join(d, n, "SKILL.md"))).map(n => {
    const fm = readFileSync(join(d, n, "SKILL.md"), "utf8").split("---")[1] || "";
    const m = fm.match(/^description:\s*(.*)$/m); let desc = m ? m[1] : "";
    try { if (desc.startsWith('"')) desc = JSON.parse(desc); } catch {}
    return { name: n, description: desc };
  }) : [];
  return reply(skills);
});

// ---- v2 tools (all read-only) ----
const daemonUrl = () => { const hb = json("site/heartbeat.json"); return hb?.port && Date.now() - Date.parse(hb.at) < 3 * 6e4 ? `http://127.0.0.1:${hb.port}` : null; };
const getLocal = async path => { const b = daemonUrl(); if (!b) return null; try { const r = await fetch(b + path, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; } };

server.registerTool("live_market", {
  title: "Live market",
  description: "Current book and features for one market: bid/ask/mid, microprice, book imbalance, taker flow, volatility, top depth and each model's latest estimate. Live from the daemon on this computer when it is running; otherwise the last published snapshot (up to 2 minutes old, no depth).",
  inputSchema: { ticker: z.string().describe("market ticker, e.g. KXBTCD-26NOV1217-T73499.99") },
}, async ({ ticker }) => {
  const live = await getLocal("/api/market/" + encodeURIComponent(ticker)); if (live) return reply({ source: "daemon (live)", ...live });
  const snap = (json("site/live.json", { markets: [] }).markets || []).find(m => m.k === ticker);
  return reply(snap ? { source: "published snapshot", at: json("site/live.json").at, ...snap } : { error: "not a watched market right now", hint: "use search_predictions to find tickers" });
});

server.registerTool("estimates", {
  title: "Model estimates for a market",
  description: "Every model's P(YES) for one market: the scored prediction (logged before resolution), later re-estimates as the price moved (not scored), outside data used, and the outcome if resolved.",
  inputSchema: { ticker: z.string() },
}, async ({ ticker }) => {
  const p = jsonl("predictions").find(r => r.ticker === ticker); if (!p) return reply({ error: "no logged prediction for this ticker" });
  const upd = allMonthFiles("updates").flatMap(f => readJsonl(f)).filter(u => u.ticker === ticker).map(u => ({ ts: u.ts, why: u.why, mid: u.mid, est: u.est }));
  return reply({ ticker, title: p.title, loggedAt: p.ts, resolvesAt: p.resolvesAt, marketPrice: p.mid, bid: p.bid, ask: p.ask, estimates: p.est, picks: p.picks, outsideData: p.ext || null, reEstimates: upd.slice(-30), outcome: outcomes()[ticker] || "pending", configVersion: p.cfg });
});

server.registerTool("scorecard", {
  title: "Scorecard (live)",
  description: "Per-predictor accuracy vs the market on the live record: Brier, log loss, calibration, simulated picks. For verdicts use eval_report (peeking-safe).",
  inputSchema: {},
}, async () => reply(json("site/scorecard.json", { error: "not built yet" })));

server.registerTool("eval_report", {
  title: "Evaluation report (the referee)",
  description: "Peeking-safe verdict per model (confidence sequence on Brier vs market, per event), picks' P&L after fees vs coin-flip and cash, breakdowns by category and lead time, model cards, leakage eval. Pass model to get one model in full; otherwise a summary of all.",
  inputSchema: { model: z.string().optional() },
}, async ({ model }) => {
  const e = json("site/evals.json"); if (!e) return reply({ error: "not built yet" });
  if (model) return reply(e.models[model] ? { ...e.models[model], card: e.cards[model] } : { error: "unknown model", models: Object.keys(e.models) });
  return reply({ at: e.at, headline: e.headline, alpha: e.alpha, family: e.family, market: e.market, controls: e.controls, leakage: { total: e.leakage.total, checks: e.leakage.checks.map(c => ({ name: c.name, violations: c.violations, of: c.of })) },
    models: Object.fromEntries(Object.values(e.models).map(m => [m.model, { status: m.status, n: m.n, events: m.events, brierVsMarket: m.vsMarket.snapshot95.diff, peekingSafeRange: [m.vsMarket.sequence.lo, m.vsMarket.sequence.hi], picks: m.money.n, pnl: m.money.total, why: m.why }])) });
});

server.registerTool("health", {
  title: "System health",
  description: "Is it running? Daemon heartbeat (host, stream state, message rate, reconnects, stale time), watchdog checks, storage, LLM spend today, recent alerts.",
  inputSchema: {},
}, async () => {
  const live = await getLocal("/api/state"), hb = live?.health || json("site/heartbeat.json"), st = json("site/status.json", {});
  return reply({ daemon: hb ? { ...hb, ageSec: Math.round((Date.now() - Date.parse(hb.at)) / 1000), running: Date.now() - Date.parse(hb.at) < 3 * 6e4 } : { running: false, note: "no heartbeat: start start.sh / start.cmd" },
    watchdog: (st.checks || []).map(c => ({ name: c.name, ok: c.ok, detail: c.detail })), needs: st.needs || [], storage: json("site/storage.json"), llm: json("state/llm-usage.json"), alerts: (json("site/alerts.json", {}).recent || []).slice(-10) });
});

server.registerTool("rules", {
  title: "Series rules",
  description: "How a series settles: the rules text as logged, plus the structured reading (source, variable, comparison, threshold, time) when the language model has extracted it.",
  inputSchema: { series: z.string().describe("series ticker, e.g. KXTEMPCHIHS") },
}, async ({ series }) => {
  const s = series.toUpperCase(), ex = jsonl("predictions").filter(r => r.series === s && r.rules).slice(-3);
  return reply(ex.length ? { series: s, category: ex[0].cat, structured: json("state/rules.json", {})[s] || null, examples: ex.map(r => ({ ticker: r.ticker, title: r.title, rules: r.rules, strike: r.strike || null })) } : { error: "no logged market in this series" });
});

let ragIndex = null;
server.registerTool("search_similar", {
  title: "Search memory (RAG)",
  description: "Find similar past markets (with how they resolved), series rules, lessons, findings and dated news facts. Answers 'how did markets like this resolve?'. Optional `before` (ISO time) restricts results to what was known before that moment.",
  inputSchema: { query: z.string(), before: z.string().optional(), kinds: z.array(z.enum(["market", "rules", "lesson", "finding", "fact"])).optional(), limit: z.number().int().min(1).max(20).default(8) },
}, async ({ query, before, kinds, limit }) => {
  ragIndex ||= new Rag(p("local/rag/index.jsonl"));
  if (!ragIndex.docs.size) return reply({ error: "memory index is empty: it is built by the daemon (hourly) or `node rag.mjs`" });
  const hits = await ragIndex.search(query, { before: before || null, kinds: kinds || null, k: limit });
  return reply({ embedding: ragIndex.mode, similarMarkets: !kinds || kinds.includes("market") ? await similarOutcomes(ragIndex, query, { before: before || null }) : null, hits: hits.map(h => ({ kind: h.kind, at: h.at, score: h.score, text: h.text })) });
});

await server.connect(new StdioServerTransport());
