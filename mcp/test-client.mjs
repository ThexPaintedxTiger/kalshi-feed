// Smoke test: start the server over stdio, list tools, call each once.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "smoke", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: [new URL("./server.mjs", import.meta.url).pathname] }));
const { tools } = await c.listTools(); console.log("tools:", tools.map(t => t.name).join(", "));
const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; console.log(`${name}: ${t.length} chars, starts ${t.slice(0, 110).replace(/\s+/g, " ")}`); if (r.isError) throw new Error(t); };
await call("get_status"); await call("get_scorecard", { which: "backtest" });
await call("search_predictions", { category: "Crypto", limit: 2 }); await call("search_predictions", { source: "backtest", outcome: "yes", limit: 1 });
await call("recall_series", { series: "KXDOTA2MAP" }); await call("list_skills");
await call("scorecard"); await call("eval_report"); await call("eval_report", { model: "calib" }); await call("health"); await call("rules", { series: "KXBTCD" });
await call("estimates", { ticker: "KXTEMPCHIHS-26NOV1019-T52.99" }); await call("live_market", { ticker: "KXTEMPCHIHS-26NOV1019-T52.99" }); await call("search_similar", { query: "Bitcoin above 73000 at 5pm", before: "2026-11-11T12:00:00Z", limit: 3 });
if (tools.length !== 12) throw new Error("expected 12 tools, got " + tools.length);
await c.close(); console.log("MCP smoke test passed");
