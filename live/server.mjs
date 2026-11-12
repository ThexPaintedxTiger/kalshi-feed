// Local live API (owner's computer only; bound to 127.0.0.1). The dashboard opened at http://localhost:<port> updates in
// well under a second from Server-Sent Events:
//   GET /               the dashboard page          GET /site/<file>.json   derived files (scorecard, status, …)
//   GET /api/state      everything live, once       GET /api/market/<ticker>  one market with book depth
//   GET /events         SSE: `tick` (changed markets, batched every 250 ms), `health` (every second), `derived` (after a rescore)
// Read-only: there is no route that changes anything.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";

export function startServer({ port = 8787, state, market, onListen = () => {} }) {
  const clients = new Set();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-private-network": "true", "cache-control": "no-store" };
  const json = (res, obj, code = 200) => { res.writeHead(code, { "content-type": "application/json", ...cors }); res.end(JSON.stringify(obj)); };
  const file = (res, path, type) => { if (!existsSync(path)) return json(res, { error: "not found" }, 404); res.writeHead(200, { "content-type": type, ...cors }); res.end(readFileSync(path)); };
  const srv = createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = decodeURIComponent(u.pathname);
    if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "access-control-allow-headers": "*" }); return res.end(); }
    if (req.method !== "GET") return json(res, { error: "read-only" }, 405);
    if (p === "/" || p === "/dashboard.html" || p === "/index.html") return file(res, "dashboard.html", "text/html; charset=utf-8");
    if (/^\/(manifest\.webmanifest|sw\.js|icon\.svg)$/.test(p)) return file(res, p.slice(1), p.endsWith(".js") ? "text/javascript" : p.endsWith(".svg") ? "image/svg+xml" : "application/manifest+json");
    const m = p.match(/^\/(?:site\/)?([\w-]+\.json)$/); if (m) return file(res, `site/${m[1]}`, "application/json");
    if (p === "/api/state") return json(res, state());
    const mk = p.match(/^\/api\/market\/(.+)$/); if (mk) { const v = market(mk[1]); return v ? json(res, v) : json(res, { error: "unknown market" }, 404); }
    if (p === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", ...cors }); res.write("retry: 2000\n\n");
      clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    json(res, { error: "not found" }, 404);
  });
  srv.on("error", e => onListen(e));
  srv.listen(port, "127.0.0.1", () => onListen(null, srv.address().port));
  return { push: (event, data) => { if (!clients.size) return; const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); }, clients: () => clients.size, close: () => { for (const c of clients) c.end(); srv.close(); } };
}
