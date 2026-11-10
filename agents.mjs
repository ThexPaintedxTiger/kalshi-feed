// AI layer for the Kalshi feed — runs inside GitHub Actions with a FREE Gemini key (repo secret GEMINI_API_KEY).
// 3 specialist agents run in parallel on the top bets; the ensemble (weighted average), edge, side,
// risk filter and stake are pure code — exact and free. Writes the picks into bets.json.
import { readFileSync, writeFileSync } from "node:fs";
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.log("No GEMINI_API_KEY secret — skipping AI picks."); process.exit(0); }
const feed = JSON.parse(readFileSync("bets.json", "utf8"));
if (process.env.FORCE !== "1" && feed.picksUpdated && Date.now() - Date.parse(feed.picksUpdated) < 55 * 60e3) {
  console.log("Picks are under an hour old — skipping to save free quota."); process.exit(0);
}
const now = Date.now();
const top = feed.markets.filter(m => (Date.parse(m.close) - now) / 864e5 <= 90 && m.vol >= 500 && m.spread <= 0.05).slice(0, 15)
  .map((m, i) => ({ id: i + 1, t: m.t, price: Math.round(m.price * 100), bid: Math.round(m.bid * 100), vol: m.vol, v24: m.v24,
    chg1h: m.chg1h, chg24h: m.chg24h, closes: m.close.slice(0, 10), rules: m.rules, url: m.url, ticker: m.ticker }));
if (!top.length) { console.log("No liquid markets to analyze."); process.exit(0); }
const data = top.map(({ url, ticker, ...m }) => m);

const SPECS = {
  momentum: "Judge from price moves (chg1h/chg24h in cents), 24h volume and spread: is money flowing in or out, and will the move continue or revert?",
  baseRate: "Judge from base rates and general knowledge: how often events like this happen before the deadline, and whether the price looks too high or too low.",
  rules: "Judge resolution and tradability risk: spread, volume, settle date and rule traps (ties, 'other', early close, vague wording). Lower your probability when the rules are risky.",
};
// Pick a free "flash" model this key can actually use (names change over time).
async function models() {
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": KEY } });
    const j = await r.json(); if (!r.ok) { console.log("ListModels:", r.status, JSON.stringify(j.error || j).slice(0, 200)); return []; }
    return (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /flash/.test(m.name) && !/image|tts|live|audio|thinking|exp|preview/.test(m.name))
      .map(m => m.name.replace("models/", "")).sort((a, b) => (/omni/.test(a) - /omni/.test(b)) || (/lite/.test(b) - /lite/.test(a)) || b.localeCompare(a));
  } catch (e) { console.log("ListModels failed:", e.message); return []; }
}
const MODELS = [...new Set([...(await models()), "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"])].slice(0, 8);
console.log("Models to try:", MODELS.join(", "));
async function ask(prompt) {
  for (const model of MODELS) for (let a = 0; a < 2; a++) {
    let r, j;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.3 } }) });
      j = await r.json().catch(() => ({}));
    } catch (e) { console.log(`${model}: network error ${e.message}`); await new Promise(s => setTimeout(s, 5000)); continue; }
    if (r.ok) {
      const txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      try { console.log(`Answer from ${model}`); return JSON.parse(txt.replace(/^```(json)?|```$/g, "").trim()); }
      catch { console.log(`${model}: answer wasn't JSON`); continue; }
    }
    const msg = JSON.stringify(j.error || j).slice(0, 250); console.log(`${model}: HTTP ${r.status} ${msg}`);
    if (r.status === 429 && /exceeded your current quota/i.test(msg) && !/per ?minute/i.test(msg)) break; // no free quota on this model — next one
    if (r.status === 429 || r.status >= 500) { const d = Math.min(30, +(String(msg).match(/retryDelay\W+(\d+)/) || [])[1] || 10); await new Promise(s => setTimeout(s, d * 1000)); continue; }
    break; // 400/403/404: try the next model
  }
  throw new Error("no model answered");
}
const today = new Date().toISOString().slice(0, 10);
// ONE call returns all three specialists' views — 3 agents for the price of 1 request (fits the free tier easily).
let views = {};
try {
  const out = await ask(`You are a team of three careful prediction-market analysts. Today is ${today}.
Prices are YES prices in cents (= the market's implied chance). Use ONLY the data below.
- "momentum": ${SPECS.momentum}
- "baseRate": ${SPECS.baseRate}
- "rules": ${SPECS.rules}
Each analyst works independently. Return JSON: {"momentum": [...], "baseRate": [...], "rules": [...]} where each array has one object per market:
{"id": number, "p": that analyst's YES probability 0-100, "conf": "high"|"med"|"low", "why": "max 15 words"}.
DATA: ${JSON.stringify(data)}`);
  for (const k of Object.keys(SPECS)) if (Array.isArray(out?.[k])) views[k] = out[k];
} catch (e) { console.log("AI failed:", e.message); }
if (!Object.keys(views).length) { console.log("No analyst answers — keeping old picks."); process.exit(0); }

const W = { high: 3, med: 2, low: 1 };
const picks = [];
for (const m of top) {
  let sw = 0, sp = 0; const why = [];
  for (const [name, arr] of Object.entries(views)) {
    const v = Array.isArray(arr) ? arr.find(x => +x.id === m.id) : null;
    if (!v || !(v.p >= 0 && v.p <= 100)) continue;
    const w = W[v.conf] || 1; sw += w; sp += w * v.p; why.push(`${name}: ${Math.round(v.p)}% (${v.conf}) ${v.why || ""}`.trim());
  }
  if (!sw) continue;
  const ens = Math.round(sp / sw * 10) / 10, edgeYes = ens - m.price, edgeNo = (100 - ens) - (100 - m.bid);
  const side = edgeYes >= edgeNo ? "YES" : "NO", edge = Math.round(Math.max(edgeYes, edgeNo) * 10) / 10, cost = side === "YES" ? m.price : 100 - m.bid;
  if (edge < 5) continue;                                    // risk filter: only clear edges
  const stakePct = Math.min(2, Math.max(0.25, Math.round(edge / 5) * 0.5)); // small, capped stakes
  picks.push({ t: m.t, ticker: m.ticker, pc: ens, url: m.url, side, edge, cost, price: m.price / 100, bid: m.bid / 100, vol: m.vol, v24: m.v24, close: m.closes,
    agents: Object.keys(views).length, stakePct, why: why.join(" · ") });
}
picks.sort((a, b) => b.edge - a.edge);
feed.picks = picks.slice(0, 10); feed.picksUpdated = new Date().toISOString(); feed.picksAgents = Object.keys(views);
writeFileSync("bets.json", JSON.stringify(feed));
console.log(`AI picks: ${feed.picks.length} (agents: ${feed.picksAgents.join(", ")})`);
