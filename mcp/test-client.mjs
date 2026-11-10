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
await c.close(); console.log("MCP smoke test passed");
