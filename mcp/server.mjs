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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);                                                      // lib.mjs reads paths relative to the repo
const p = f => join(ROOT, f);
const json = (f, d = null) => { try { return JSON.parse(readFileSync(p(f), "utf8")); } catch { return d; } };
// Every month of a log, hot + gzipped archive, oldest first (same reader as the pipeline).
const jsonl = kind => allMonthFiles(kind).flatMap(f => readJsonl(f));
const outcomes = () => Object.fromEntries(readJsonl("data/outcomes.jsonl").map(o => [o.ticker, o.result]));
const reply = obj => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });

const server = new McpServer({ name: "kalshi-agent", version: "1.0.0" });

server.registerTool("get_status", {
  title: "Agent status",
  description: "Goal status (SUCCESS/FAILURE/in progress), pipeline health and each predictor's status and recommendation, from progress.json. Start here for 'how is the agent doing'.",
  inputSchema: {},
}, async () => {
  const runs = existsSync(p("data/runs.jsonl")) ? readFileSync(p("data/runs.jsonl"), "utf8").trim().split("\n") : [];
  return reply({ progress: json("progress.json", {}), lastRun: runs.length ? JSON.parse(runs[runs.length - 1]) : null });
});

server.registerTool("get_scorecard", {
  title: "Scorecard",
  description: "Accuracy (Brier, log loss vs the market price), calibration and simulated P&L per predictor. which='live' is the forward record (the one that counts); which='backtest' is past settled markets (supporting evidence only).",
  inputSchema: { which: z.enum(["live", "backtest"]).default("live") },
}, async ({ which }) => reply(json(which === "live" ? "scorecard.json" : "backtest-scorecard.json", { error: "not built yet" })));

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
  const s = series.toUpperCase(), mem = json("data/memory/series.json", { series: {} });
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

await server.connect(new StdioServerTransport());
