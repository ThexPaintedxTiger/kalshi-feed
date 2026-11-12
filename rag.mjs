// Memory the system can retrieve (RAG). A local index on the owner's computer (local/rag/index.jsonl), free.
// What is indexed: each series' rules and settlement source · past markets with outcome, price and every model's estimate ·
// lessons and findings · extracted news facts with source and time.
// Embeddings come from Ollama (nomic-embed-text). Without Ollama (e.g. in the cloud) it falls back to a deterministic
// word-hash vector, which still finds similar market titles and rules; the index records which kind it holds.
// NO LEAKAGE: every item has `at` (when that knowledge existed: a market's settlement time, a fact's publish time).
// search(…, { before }) only returns items with at < before, so a prediction or backtest can never retrieve its own future.
// Every retrieval made for a prediction is logged (state/rag-log.jsonl) and checked by the leakage eval.
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { readJsonl, allMonthFiles } from "./lib.mjs";
import { embed as llmEmbed } from "./llm.mjs";

const FILE = "local/rag/index.jsonl", DIM = 256;
const words = s => String(s).toLowerCase().match(/[a-z0-9$%.°]+/g) || [];
// Deterministic lexical vector: hashed unigrams + bigrams, L2-normalised.
export function lexical(text) {
  const v = new Float64Array(DIM), w = words(text), add = t => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } v[(h >>> 0) % DIM] += 1; };
  w.forEach((t, i) => { add(t); if (i) add(w[i - 1] + " " + t); });
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return Array.from(v, x => Math.round(x / n * 1e4) / 1e4);
}
const cos = (a, b) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / (Math.sqrt(na * nb) || 1); };

// Documents from the project's own data. Pure given a store-like object { preds, out (Map), backtest }.
export function documents(store, { lessons = "", findings = "", facts = [] } = {}) {
  const docs = [], seenSeries = new Map();
  for (const p of store.preds) {
    if (p.rules && !seenSeries.has(p.series)) { seenSeries.set(p.series, 1); docs.push({ id: `rules:${p.series}`, kind: "rules", at: p.ts, series: p.series, text: `Rules for series ${p.series} (${p.cat}). Example market: ${p.title}. ${p.rules}` }); }
    const o = store.out.get(p.ticker); if (!o || (o.result !== "yes" && o.result !== "no")) continue;
    docs.push({ id: `mkt:${p.ticker}`, kind: "market", at: o.settledAt || p.resolvesAt, series: p.series, ticker: p.ticker,
      text: `${p.title} [${p.cat}] priced ${Math.round(p.mid * 100)}¢ ${p.leadMin} min before resolution; estimates ${Object.entries(p.est).filter(([k]) => k !== "market").map(([k, v]) => `${k} ${Math.round(v * 100)}¢`).join(", ") || "none"}; resolved ${o.result.toUpperCase()}.`,
      meta: { mid: p.mid, y: o.result === "yes" ? 1 : 0, est: p.est, ts: p.ts } });
  }
  for (const r of store.backtest || []) docs.push({ id: `bt:${r.ticker}`, kind: "market", at: r.settledAt || r.resolvesAt, series: r.series, ticker: r.ticker, text: `${r.title} [${r.cat}] priced ${Math.round(r.mid * 100)}¢ ${r.leadMin} min before resolution; resolved ${r.y ? "YES" : "NO"}.`, meta: { mid: r.mid, y: r.y, ts: r.ts } });
  const notes = (md, kind) => md.split(/\n(?=- \d{4}-\d{2}-\d{2}|## )/).map(s => s.trim()).filter(s => s.length > 40).forEach((s, i) => { const d = s.match(/\d{4}-\d{2}-\d{2}/)?.[0]; docs.push({ id: `${kind}:${i}:${d || "x"}`, kind, at: d ? d + "T23:59:59Z" : "2026-11-10T00:00:00Z", text: s.slice(0, 1500) }); });
  notes(lessons, "lesson"); notes(findings, "finding");
  for (const f of facts) docs.push({ id: `fact:${f.id}`, kind: "fact", at: f.at, series: f.series || null, text: `${f.entity}: ${f.claim} (source ${f.url}, ${f.at})`, meta: { url: f.url } });
  return docs;
}

export class Rag {
  constructor(file = FILE) { this.file = file; this.docs = new Map(); this.mode = null; if (existsSync(file)) for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean)) { try { const d = JSON.parse(l); this.docs.set(d.id, d); this.mode ||= d.emb; } catch {} } }
  // Add documents not yet indexed. embedFn(texts) → vectors or null. One embedding kind per index: a change of kind re-embeds everything.
  async add(docs, embedFn = llmEmbed) {
    let fresh = docs.filter(d => !this.docs.has(d.id)); if (!fresh.length) return 0;
    const probe = await embedFn([fresh[0].text.slice(0, 2000)]), mode = probe ? "ollama" : "lexical";
    if (this.mode && this.mode !== mode) { fresh = [...this.docs.values(), ...fresh].map(({ vec, emb, ...d }) => d); this.docs.clear(); mkdirSync(this.file.slice(0, this.file.lastIndexOf("/")), { recursive: true }); writeFileSync(this.file, ""); }
    this.mode = mode; const out = [];
    for (let i = 0; i < fresh.length; i += 32) {
      const batch = fresh.slice(i, i + 32), vecs = mode === "ollama" ? await embedFn(batch.map(d => d.text.slice(0, 2000))) : null;
      batch.forEach((d, j) => { const row = { ...d, emb: mode, vec: vecs?.[j]?.map(x => Math.round(x * 1e4) / 1e4) ?? lexical(d.text) }; this.docs.set(d.id, row); out.push(row); });
    }
    mkdirSync(this.file.slice(0, this.file.lastIndexOf("/")), { recursive: true }); appendFileSync(this.file, out.map(d => JSON.stringify(d)).join("\n") + "\n");
    return out.length;
  }
  // Top-k items similar to `query`, only those that existed strictly before `before` (ISO or ms). kinds/series narrow it.
  async search(query, { before = null, k = 5, kinds = null, series = null, embedFn = llmEmbed, log = null } = {}) {
    const cut = before == null ? Infinity : typeof before === "number" ? before : Date.parse(before);
    const q = this.mode === "ollama" ? (await embedFn([query]))?.[0] : null, qv = q || lexical(query);
    const hits = [];
    for (const d of this.docs.values()) {
      if (!(Date.parse(d.at) < cut) || (kinds && !kinds.includes(d.kind)) || (series && d.series !== series)) continue;
      if (q ? d.emb !== "ollama" : false) continue;
      hits.push({ id: d.id, kind: d.kind, at: d.at, series: d.series ?? null, ticker: d.ticker ?? null, text: d.text, meta: d.meta ?? null, score: Math.round(cos(qv, q ? d.vec : d.emb === "lexical" ? d.vec : lexical(d.text)) * 1e4) / 1e4 });
    }
    const top = hits.sort((a, b) => b.score - a.score).slice(0, k);
    if (log && before != null) { mkdirSync("state", { recursive: true }); appendFileSync("state/rag-log.jsonl", top.map(h => JSON.stringify({ id: h.id, at: h.at, asOf: new Date(cut).toISOString(), for: log })).join("\n") + (top.length ? "\n" : "")); }
    return top;
  }
  stats() { const by = {}; for (const d of this.docs.values()) by[d.kind] = (by[d.kind] || 0) + 1; return { docs: this.docs.size, byKind: by, embedding: this.mode }; }
}
// "How did markets like this resolve?" — base rate of similar settled markets (before a given time).
export async function similarOutcomes(rag, query, opt = {}) {
  const hits = await rag.search(query, { ...opt, kinds: ["market"], k: opt.k ?? 12 }), n = hits.length;
  return { n, yesRate: n ? Math.round(hits.reduce((s, h) => s + h.meta.y, 0) / n * 1e3) / 1e3 : null, avgPrice: n ? Math.round(hits.reduce((s, h) => s + h.meta.mid, 0) / n * 1e3) / 1e3 : null, examples: hits.slice(0, 6).map(h => ({ text: h.text, at: h.at, score: h.score })) };
}
export const readFacts = () => allMonthFiles("facts").flatMap(f => readJsonl(f));
export const ragLog = () => (existsSync("state/rag-log.jsonl") ? readFileSync("state/rag-log.jsonl", "utf8").split("\n").filter(Boolean).slice(-5000).map(l => JSON.parse(l)) : []);

// Index step (hourly): add whatever is new.
export async function run(ctx, { embedFn = llmEmbed } = {}) {
  const rag = ctx.rag ||= new Rag(), rd = f => (existsSync(f) ? readFileSync(f, "utf8") : "");
  const n = await rag.add(documents(ctx.store, { lessons: rd("docs/lessons.md"), findings: rd("docs/findings.md"), facts: readFacts() }), embedFn);
  ctx.emit("rag-stats", { at: new Date().toISOString(), ...rag.stats() }, "state");
  return `rag: +${n} items, ${rag.docs.size} indexed (${rag.mode || "empty"})`;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const { makeCtx } = await import("./core/ctx.mjs"), ctx = makeCtx(); console.log(await run(ctx));
  const q = process.argv.slice(2).join(" "); if (q) console.log(JSON.stringify(await similarOutcomes(ctx.rag, q), null, 1));
}
