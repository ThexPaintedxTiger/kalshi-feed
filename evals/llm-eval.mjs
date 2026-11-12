// LLM evals: a FIXED set of past cases with known answers (evals/llm-cases.json), rerun whenever the model or a prompt changes.
//   rules      does it read a market's rules correctly (comparison, threshold, settlement source)?
//   facts      of the facts it extracts from news, how many are really in the text (precision), how many it finds (recall),
//              does it stay silent on opinion, and does it refuse a prompt-injection planted in the text?
//   predictor  the `llm` predictor's Brier on 40 resolved markets vs the market price (retrieval limited to before each one)
// Results: state/llm-eval.json (shown on the dashboard, Ops). Costs nothing with the local model; never escalates to Claude.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rulesFor, extractFacts, estimate, promptVersion } from "../agent.mjs";
import { r4 } from "../lib.mjs";

export const CASES = () => JSON.parse(readFileSync(fileURLToPath(new URL("./llm-cases.json", import.meta.url)), "utf8"));
const has = (text, words) => words.every(w => String(text).toLowerCase().includes(w.toLowerCase()));

export async function evaluate({ deps = {}, rag = null, cases = CASES() } = {}) {
  const d = { ...deps, noSave: true }, R = { rules: [], facts: [], markets: [] };
  for (const c of cases.rules) {
    const r = await rulesFor("eval:" + c.series, c.text, d); if (!r) { R.rules.push({ series: c.series, ok: false, why: "no answer" }); continue; }
    const cmp = r.comparison === c.gold.comparison || (c.gold.comparison === "above" && r.comparison === "at_least" && false), thr = c.gold.threshold == null || Math.abs((r.threshold ?? NaN) - c.gold.threshold) < 1e-6, src = has(`${r.source} ${r.variable}`, [c.gold.sourceIncludes]);
    R.rules.push({ series: c.series, ok: cmp && thr && src, comparison: cmp, threshold: thr, source: src });
  }
  let tp = 0, fp = 0, found = 0, goldN = 0, injected = 0, noUrl = true;
  for (const c of cases.facts) {
    const fs = await extractFacts(c.item, d), claims = fs.map(f => `${f.entity} ${f.claim}`);
    const matched = c.gold.map(g => claims.some(t => has(t, g))), good = claims.filter(t => c.gold.some(g => has(t, g))).length;
    tp += good; fp += claims.length - good; found += matched.filter(Boolean).length; goldN += c.gold.length;
    if (c.forbid && claims.some(t => c.forbid.some(w => t.toLowerCase().includes(w)))) injected++;
    if (c.expectNone && fs.length) noUrl = false;
    R.facts.push({ id: c.id, extracted: claims.length, correct: good, goldFound: matched.filter(Boolean).length, gold: c.gold.length });
  }
  let b = 0, bm = 0, n = 0;
  if (rag) for (const m of cases.markets) { const e = await estimate({ ...m, at: Date.parse(m.ts) }, rag, d); if (!e) continue; n++; b += (e.p - m.y) ** 2; bm += (m.mid - m.y) ** 2; R.markets.push({ ticker: m.ticker, p: e.p, mid: m.mid, y: m.y }); }
  const answered = R.rules.filter(x => x.why !== "no answer").length;
  return { at: new Date().toISOString(), prompt: promptVersion(), model: deps.modelName || null, n: cases.rules.length + cases.facts.length + n, available: answered > 0,
    rulesAcc: r4(R.rules.filter(x => x.ok).length / cases.rules.length), factPrecision: tp + fp ? r4(tp / (tp + fp)) : null, factRecall: goldN ? r4(found / goldN) : null, injectionFollowed: injected, sourcelessFactsDropped: noUrl,
    predictor: n ? { n, brier: r4(b / n), brierMarket: r4(bm / n), diff: r4((b - bm) / n) } : null, detail: R };
}
// Hourly step: only reruns when the model or prompts changed (or never ran), and only if a local model is reachable.
export async function run(ctx, { deps } = {}) {
  const prev = ctx.get("llm-eval", "state"); if (prev && prev.prompt === promptVersion() && prev.available) return null;
  const { localAvailable } = await import("../llm.mjs"); if (!deps && !(await localAvailable())) return "llm eval: no local model running (start Ollama) — skipped";
  const r = await evaluate({ deps: deps || {}, rag: ctx.rag }); r.model ||= (await import("../lib.mjs")).config.llm?.local || "llama3.2:3b";
  const { detail, ...summary } = r; ctx.emit("llm-eval", { ...summary, failures: detail.rules.filter(x => !x.ok).map(x => x.series) }, "state");
  return `llm eval (${r.model}): rules ${Math.round(r.rulesAcc * 100)}%, fact precision ${r.factPrecision == null ? "n/a" : Math.round(r.factPrecision * 100) + "%"}, injection followed ${r.injectionFollowed}×${r.predictor ? `, llm Brier ${r.predictor.brier} vs market ${r.predictor.brierMarket}` : ""}`;
}
if (import.meta.url === `file://${process.argv[1]}`) { const { makeCtx } = await import("../core/ctx.mjs"), { run: ragRun } = await import("../rag.mjs"), ctx = makeCtx(); await ragRun(ctx); console.log(await run(ctx) ?? "llm eval: up to date"); }
