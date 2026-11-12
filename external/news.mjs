// News → dated facts. Fetches public RSS feeds (config.news.feeds), politely: one request per feed at most every
// `everyMinutes`, a clear user agent, cached item ids so nothing is processed twice. Each new item goes to the local model,
// which extracts structured facts { entity, claim, time, url }; rows are appended to data/facts/YYYY-MM.jsonl with the
// item's publish time (`at`) and the fetch time. Facts are indexed for retrieval with `at`, so a prediction can only
// ever see facts published before it. Feed text is data: it is never executed or followed.
import { readJson, writeJson, appendJsonl, sleep, config } from "../lib.mjs";
import { extractFacts } from "../agent.mjs";

const SEEN = "state/news-seen.json", UA = { "user-agent": "kalshi-research-agent (read-only research; RSS)" };
const strip = s => s.replace(/<[^>]+>/g, " ");
const un = s => strip(strip(String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")).replace(/\s+/g, " ").trim();
// Minimal RSS/Atom reader → [{ title, text, url, at }].
export function parseFeed(xml) {
  const items = [], tag = (b, t) => (b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")) || [])[1];
  for (const b of String(xml).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || []) {
    const link = un(tag(b, "link")) || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1], when = Date.parse(un(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")));
    if (!link || !/^https?:\/\//.test(link) || !Number.isFinite(when)) continue;
    items.push({ title: un(tag(b, "title")), text: un(tag(b, "description") || tag(b, "summary") || tag(b, "content")), url: link, at: new Date(when).toISOString() });
  }
  return items;
}
export async function run(ctx, { fetchFn = fetch, deps = undefined, max = 12 } = {}) {
  const N = config.news || {}, feeds = N.feeds || []; if (!feeds.length) return "news: no feeds configured";
  const seen = readJson(SEEN, { ids: {}, last: {} }), now = Date.now(), out = []; let items = 0, skipped = 0;
  for (const url of feeds) {
    if (now - (seen.last[url] || 0) < (N.everyMinutes ?? 30) * 6e4) continue;
    seen.last[url] = now;
    try { const r = await fetchFn(url, { headers: UA }); if (!r.ok) continue;
      for (const it of parseFeed(await r.text()).slice(0, 20)) {
        if (seen.ids[it.url] || Date.parse(it.at) > now || now - Date.parse(it.at) > 3 * 864e5) continue;            // already done, future-dated, or older than 3 days
        if (items >= max) { skipped++; continue; }
        items++; const facts = await extractFacts(it, deps); if (facts === null) continue;
        seen.ids[it.url] = now; for (const f of facts) out.push({ ...f, feed: url, fetchedAt: new Date().toISOString() });
      }
    } catch (e) { ctx.log(`news: ${url}: ${e.message}`); }
    await sleep(deps ? 0 : 500);
  }
  for (const k of Object.keys(seen.ids)) if (now - seen.ids[k] > 10 * 864e5) delete seen.ids[k];
  writeJson(SEEN, seen);
  for (const [ym, rs] of Object.entries(out.reduce((g, f) => ((g[f.at.slice(0, 7)] ||= []).push(f), g), {}))) appendJsonl(`data/facts/${ym}.jsonl`, rs);
  if (out.length) ctx.emit("facts", { at: new Date().toISOString(), recent: out.slice(-40) }, "state");
  return `news: ${items} new items → ${out.length} facts${skipped ? ` (${skipped} left for the next run)` : ""}`;
}
