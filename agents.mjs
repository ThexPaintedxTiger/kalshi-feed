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
    chg1h: m.chg1h, chg24h: m.chg24h, closes: m.close.slice(0, 10), rules: m.rules, url: m.url }));
if (!top.length) { console.log("No liquid markets to analyze."); process.exit(0); }
const data = top.map(({ url, ...m }) => m);

const SPECS = {
  momentum: "Judge from price moves (chg1h/chg24h in cents), 24h volume and spread: is money flowing in or out, and will the move continue or revert?",
  baseRate: "Judge from base rates and general knowledge: how often events like this happen before the deadline, and whether the price looks too high or too low.",
  rules: "Judge resolution and tradability risk: spread, volume, settle date and rule traps (ties, 'other', early close, vague wording). Lower your probability when the rules are risky.",
};
const MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
async function ask(prompt) {
  let last;
  for (const model of MODELS) for (let a = 0; a < 3; a++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.3 } }) });
    if (r.status === 429 || r.status >= 500) { last = "HTTP " + r.status; await new Promise(s => setTimeout(s, 15000 * (a + 1))); continue; }
    if (r.status === 404) { last = model + " not found"; break; }
    const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j.error || j).slice(0, 300));
    const txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    return JSON.parse(txt.replace(/^```(json)?|```$/g, "").trim());
  }
  throw new Error("Gemini failed: " + last);
}
const today = new Date().toISOString().slice(0, 10);
const results = await Promise.allSettled(Object.entries(SPECS).map(async ([name, job]) => [name, await ask(
`You are a careful prediction-market analyst. Today is ${today}. ${job}
Use ONLY the data below; prices are YES prices in cents (= the market's implied chance).
Return JSON: an array with one object per market: {"id": number, "p": your YES probability 0-100, "conf": "high"|"med"|"low", "why": "max 15 words"}.
DATA: ${JSON.stringify(data)}`)]));
const views = {}; for (const r of results) if (r.status === "fulfilled") views[r.value[0]] = r.value[1]; else console.log("Agent failed:", r.reason?.message);
if (!Object.keys(views).length) { console.log("All agents failed — keeping old picks."); process.exit(0); }

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
  picks.push({ t: m.t, pc: ens, url: m.url, side, edge, cost, price: m.price / 100, bid: m.bid / 100, vol: m.vol, v24: m.v24, close: m.closes,
    agents: Object.keys(views).length, stakePct, why: why.join(" · ") });
}
picks.sort((a, b) => b.edge - a.edge);
feed.picks = picks.slice(0, 10); feed.picksUpdated = new Date().toISOString(); feed.picksAgents = Object.keys(views);
writeFileSync("bets.json", JSON.stringify(feed));
console.log(`AI picks: ${feed.picks.length} (agents: ${feed.picksAgents.join(", ")})`);
