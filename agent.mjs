// What the language model is used for. It reads and summarises; it never trades and never sets a probability that is
// trusted: its one probability output is logged as the separate `llm` predictor and scored like every other.
//   rulesFor(series)     structured settlement rules (source, variable, comparison, time) from the market's own rules text
//   extractFacts(item)   news item → facts { entity, claim, time, url }: features with timestamps, never free text into a model
//   estimate(market)     the `llm` predictor: rules + similar past markets + dated facts → P(YES) (retrieval is time-filtered)
//   explainMiss(row)     one sentence on why a model was further from the outcome than the market
//   briefing(ctx)        the daily briefing (numbers come from code; the model only words it, and only if it is available)
import { config, readJsonl, appendJsonl, readJson, writeJson, r4, kalshi } from "./lib.mjs";
import { ask, wrap } from "./llm.mjs";
import { similarOutcomes } from "./rag.mjs";

export const PROMPTS = {
  rules: 'From the market rules in <data>, extract: {"source": who publishes the settling value, "variable": what is measured, "comparison": one of "above","below","at_least","at_most","between","exactly","event", "threshold": number or null, "time": when it is measured (as written), "ambiguous": true if the rules leave real doubt about how it settles}.',
  facts: 'From the news item in <data>, list only concrete, checkable statements relevant to prediction markets (numbers released, decisions made, results, schedules). Reply {"facts":[{"entity": who/what, "claim": one sentence stating the fact, "time": ISO time the fact refers to or null}]}. If there are none reply {"facts":[]}. Do not infer or predict.',
  estimate: 'Estimate the probability that the market in <data> resolves YES. Use the rules, the dated facts and how similar past markets resolved. The current market price is given: stay close to it unless the material gives a specific reason. Reply {"p": number between 0.01 and 0.99, "reason": one short sentence, "conflict": true if sources disagree}.',
  miss: 'In one plain sentence, say the most likely reason the model estimate in <data> was further from the outcome than the market price. Reply {"why": "..."}.',
};
export const promptVersion = () => Object.values(PROMPTS).join("|").length + ":" + (config.llm?.local || "llama3.2:3b");

const RULES = "state/rules.json";
export async function rulesFor(series, text, deps) {
  const all = readJson(RULES, {}); if (all[series]) return all[series];
  if (!text) return null;
  let r = await ask({ purpose: "rules", system: PROMPTS.rules, prompt: wrap(text) }, deps);
  // Ambiguous rules are a hard case worth a better reader.
  if (r?.data?.ambiguous) r = (await ask({ purpose: "rules-ambiguous", system: PROMPTS.rules, prompt: wrap(text), escalate: true }, deps)) || r;
  if (!r?.data) return null;
  const d = r.data, out = { series, source: String(d.source || "").slice(0, 120), variable: String(d.variable || "").slice(0, 160), comparison: String(d.comparison || ""), threshold: Number.isFinite(+d.threshold) && d.threshold !== null ? +d.threshold : null, time: String(d.time || "").slice(0, 80), ambiguous: !!d.ambiguous, by: r.model, at: new Date().toISOString() };
  if (!deps?.noSave) { all[series] = out; writeJson(RULES, all); }
  return out;
}
// item: { title, text, url, at (publish time ISO) } → fact rows. A fact without a source URL or time is dropped.
export async function extractFacts(item, deps) {
  if (!item?.url || !Number.isFinite(Date.parse(item.at))) return [];
  const r = await ask({ purpose: "facts", system: PROMPTS.facts, prompt: wrap(`${item.title}\n${String(item.text || "").slice(0, 3000)}`) }, deps);
  return (r?.data?.facts || []).filter(f => f && typeof f.claim === "string" && f.claim.length > 8 && typeof f.entity === "string").slice(0, 8)
    .map((f, i) => ({ id: `${Buffer.from(item.url).toString("base64url").slice(-24)}:${i}`, entity: f.entity.slice(0, 80), claim: f.claim.slice(0, 300), time: Number.isFinite(Date.parse(f.time)) ? new Date(Date.parse(f.time)).toISOString() : null, url: item.url, at: new Date(Date.parse(item.at)).toISOString(), by: r.model }));
}
// The `llm` predictor for one market snapshot c (needs c.title, c.rules). Everything retrieved is dated before c.at.
export async function estimate(c, rag, deps) {
  if (!rag) return null;
  const asOf = c.at, sim = await similarOutcomes(rag, c.title, { before: asOf, k: 8, series: null, log: c.ticker }), facts = await rag.search(c.title, { before: asOf, kinds: ["fact"], k: 5, log: c.ticker });
  const material = `Market: ${c.title}\nRules: ${c.rules || "n/a"}\nMarket price now: ${Math.round(c.mid * 100)}¢, ${Math.round(c.leadMin)} minutes before resolution\nSimilar past markets (${sim.n}): YES in ${sim.yesRate == null ? "n/a" : Math.round(sim.yesRate * 100) + "%"} at an average price of ${sim.avgPrice == null ? "n/a" : Math.round(sim.avgPrice * 100) + "¢"}\n${sim.examples.map(e => "- " + e.text).join("\n")}\nDated facts:\n${facts.map(f => "- " + f.text).join("\n") || "- none"}`;
  let r = await ask({ purpose: "estimate", system: PROMPTS.estimate, prompt: wrap(material) }, deps);
  if (!r?.data) return null;
  // High-value disagreement or conflicting sources → one better opinion, if the budget allows.
  if ((Math.abs(+r.data.p - c.mid) >= (config.llm?.escalateGap ?? 0.15) || r.data.conflict) && (c.v24 ?? 0) >= (config.llm?.escalateMinVolume ?? 2000)) r = (await ask({ purpose: "estimate-disagreement", system: PROMPTS.estimate, prompt: wrap(material), escalate: true }, deps)) || r;
  const p = +r.data.p; if (!(p > 0 && p < 1)) return null;
  const d = config.models?.llm?.maxDev ?? 0.15;
  return { p: r4(Math.min(0.99, Math.max(0.01, Math.min(c.mid + d, Math.max(c.mid - d, p))))), raw: r4(p), reason: String(r.data.reason || "").slice(0, 200), similar: sim.n, facts: facts.length, by: r.model, src: r.provider, at: new Date().toISOString() };
}
export async function explainMiss(m, deps) { const r = await ask({ purpose: "miss", system: PROMPTS.miss, prompt: wrap(JSON.stringify(m)) }, deps); return r?.data?.why ? String(r.data.why).slice(0, 240) : null; }

// Daily briefing: one row a day in data/briefing.jsonl. The facts are assembled by code; the model may reword them.
export async function briefing(ctx, deps) {
  const day = new Date().toISOString().slice(0, 10); if (readJsonl("data/briefing.jsonl").some(b => (b.ts || "").slice(0, 10) === day && b.kind === "daily")) return null;
  const ev = ctx.get("evals"), st = ctx.get("status"), hb = ctx.get("heartbeat"), mk = ctx.get("maker"), dec = readJsonl("data/decisions.jsonl").filter(d => Date.now() - Date.parse(d.ts) < 36 * 36e5);
  if (!ev) return null;
  const models = Object.values(ev.models).filter(m => m.status !== "RETIRED").map(m => `${m.model}: ${m.status.replace(/_/g, " ").toLowerCase()} (${m.n} resolved, ${m.vsMarket.snapshot95.diff == null ? "n/a" : (m.vsMarket.snapshot95.diff > 0 ? "+" : "") + m.vsMarket.snapshot95.diff} Brier vs market)`);
  const facts = [`Should I trade? ${st?.trade?.answer || "No"}.`, ev.headline, `Models — ${models.join("; ")}.`, `Leakage eval: ${ev.leakage.total} violations.`,
    hb ? `Daemon: ${hb.mode === "ws" ? "stream live" : "REST prices"} on ${hb.host}, ${hb.ws?.reconnects ?? 0} reconnects, ${hb.staleTotalSec}s stale since start.` : "Daemon: no heartbeat (cloud fallback only).",
    mk ? `Maker paper portfolio: ${mk.fills}/${mk.orders} orders filled, ${mk.pnl >= 0 ? "+" : ""}$${mk.pnl} after fees.` : "", dec.length ? `Decisions since the last briefing: ${dec.map(d => d.decision).join("; ")}.` : "No new decisions."].filter(Boolean);
  let text = facts.join(" "), by = "code";
  const r = await ask({ purpose: "briefing", json: true, system: 'Rewrite the status notes in <data> as a short plain-English briefing for the owner (4–6 sentences, no jargon, keep every number exactly, add nothing). Reply {"text": "..."}.', prompt: wrap(text) }, deps);
  if (r?.data?.text && facts.every(f => (f.match(/-?\d+(\.\d+)?/g) || []).slice(0, 2).every(n => r.data.text.includes(n)))) { text = String(r.data.text).slice(0, 1500); by = r.model; }   // keep the model's wording only if it kept the numbers
  const row = { ts: new Date().toISOString(), kind: "daily", by, text, facts };
  appendJsonl("data/briefing.jsonl", [row]); return row;
}
