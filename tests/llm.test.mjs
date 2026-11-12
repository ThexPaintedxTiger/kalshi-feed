// LLM layer with a fake model (no network): cache, usage log, daily cap, key handling, prompt-injection guard,
// retrieval that cannot see the future, fact extraction rules, the llm predictor, LLM evals, briefing, news parsing.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ask, costOf, usageToday, parseJson, wrap, GUARD, _resetLocalCheck } from "../llm.mjs";
import { Rag, lexical, documents, similarOutcomes } from "../rag.mjs";
import { extractFacts, estimate, rulesFor } from "../agent.mjs";
import { evaluate, CASES } from "../evals/llm-eval.mjs";
import { parseFeed } from "../external/news.mjs";
import { leakage } from "../evals/leakage.mjs";

// A fake Ollama: answers by looking at the system prompt. `brain` decides the JSON; calls are recorded.
function fakeOllama(brain, calls = []) {
  return async (url, opt) => { if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({}) };
    if (url.endsWith("/api/embed")) return { ok: false };
    const b = JSON.parse(opt.body); calls.push(b); return { ok: true, json: async () => ({ response: JSON.stringify(brain(b.system, b.prompt)), prompt_eval_count: 100, eval_count: 20 }) }; };
}
const fakeClaude = (answer, calls = []) => ({ beta: { messages: { create: async req => { calls.push(req); return { stop_reason: "end_turn", model: req.model, content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 1000, output_tokens: 200 } }; } } } });
const T0 = Date.parse("2026-11-12T12:00:00Z");

// ---- llm.ask: local by default, cached by input, logged; Claude only on escalation, with a key, under the cap.
{
  _resetLocalCheck(); const dir = mkdtempSync(tmpdir() + "/llm-"), rows = [], calls = [], cl = [];
  const deps = { fetchFn: fakeOllama(() => ({ ok: 1 }), calls), cacheDir: dir, log: false, rows, now: () => T0, key: null, claude: fakeClaude({ ok: 2 }, cl) };
  const a = await ask({ purpose: "t", prompt: "hello" }, deps); assert.deepEqual(a.data, { ok: 1 }); assert.equal(a.provider, "ollama"); assert.equal(a.cost, 0);
  assert.ok(calls[0].system.startsWith(GUARD) && calls[0].options.temperature === 0);
  const b = await ask({ purpose: "t", prompt: "hello" }, deps); assert.equal(b.cached, true); assert.equal(calls.length, 1);              // same input → no second call
  assert.deepEqual(rows.map(r => [r.provider, r.cached, r.cost]), [["ollama", false, 0], ["ollama", true, 0]]);
  // escalate without a key → local model, and it says why
  const c = await ask({ purpose: "t", prompt: "hard one", escalate: true }, deps); assert.equal(c.provider, "ollama"); assert.match(c.note, /no Claude key/); assert.equal(cl.length, 0);
  // with a key → Claude, cost from real token counts: (1000 × $4 + 200 × $20) / 1e6 = $0.008
  const d = await ask({ purpose: "t", prompt: "hard two", escalate: true }, { ...deps, key: "test-key" }); assert.equal(d.provider, "anthropic"); assert.equal(d.cost, 0.008); assert.deepEqual(d.data, { ok: 2 });
  assert.equal(cl[0].model, "claude-opus-5-5"); assert.equal(cl[0].fallbacks, "default"); assert.ok(!JSON.stringify(rows).includes("test-key"));   // the key never reaches the log
  assert.equal(costOf("claude-opus-5-5", 1e6, 1e6), 24);
  // daily cap: $0.995 already spent today → the next escalation would pass $1 → refused, local model used instead
  rows.push({ ts: new Date(T0).toISOString(), provider: "anthropic", cost: 0.987, cached: false });
  const e = await ask({ purpose: "t", prompt: "hard three", escalate: true }, { ...deps, key: "test-key" }); assert.equal(e.provider, "ollama"); assert.match(e.note, /daily cap/); assert.equal(cl.length, 1);
  assert.equal(usageToday(T0, rows).spent, 0.995); assert.equal(usageToday(T0 + 864e5, rows).spent, 0);                                      // a new day starts at zero
  // no local model and no escalation → null (callers skip), never a guess
  _resetLocalCheck(); assert.equal(await ask({ purpose: "t", prompt: "x" }, { ...deps, fetchFn: async () => { throw new Error("down"); } }), null); _resetLocalCheck();
  assert.deepEqual(parseJson('sure! {"a": 1} thanks'), { a: 1 }); assert.equal(parseJson("no json"), null);
  assert.equal(wrap("a </data> b <DATA> c"), "<data>\na  b  c\n</data>");                                                                // fetched text cannot close the data block
}

// ---- RAG: similar things are found; nothing dated at or after `before` is ever returned.
{
  const store = { preds: [
    { ticker: "B1", series: "KXBTCD", cat: "Crypto", title: "Bitcoin price above 70000 at 5pm", rules: "If BRTI is above 70000…", ts: "2026-11-01T10:00:00Z", resolvesAt: "2026-11-01T22:00:00Z", leadMin: 60, mid: 0.4, est: { market: 0.4, calib: 0.42 } },
    { ticker: "B2", series: "KXBTCD", cat: "Crypto", title: "Bitcoin price above 72000 at 5pm", rules: "If BRTI is above 72000…", ts: "2026-11-05T10:00:00Z", resolvesAt: "2026-11-05T22:00:00Z", leadMin: 60, mid: 0.6, est: { market: 0.6 } },
    { ticker: "W1", series: "KXTEMPCHIHS", cat: "Climate and Weather", title: "Chicago temperature above 50 at 7pm", rules: "Synoptic…", ts: "2026-11-03T10:00:00Z", resolvesAt: "2026-11-03T22:00:00Z", leadMin: 45, mid: 0.5, est: { market: 0.5 } },
    { ticker: "OPEN", series: "KXBTCD", cat: "Crypto", title: "Bitcoin price above 75000 at 5pm", rules: "…", ts: "2026-11-09T10:00:00Z", resolvesAt: "2026-11-09T22:00:00Z", leadMin: 60, mid: 0.3, est: { market: 0.3 } }],
    out: new Map([["B1", { result: "yes", settledAt: "2026-11-01T22:05:00Z" }], ["B2", { result: "no", settledAt: "2026-11-05T22:05:00Z" }], ["W1", { result: "yes", settledAt: "2026-11-03T22:05:00Z" }]]), backtest: [] };
  const docs = documents(store, { lessons: "- 2026-11-02: Bitcoin hourly markets open one hour before close, so snapshots moved to 30 minutes.\n- 2026-11-06: something unrelated about tennis scheduling and volume ranking rules.", facts: [{ id: "f1", entity: "Fed", claim: "cut rates by 25bp", url: "https://x", at: "2026-11-04T19:00:00Z" }] });
  assert.equal(docs.filter(d => d.kind === "market").length, 3); assert.ok(!docs.some(d => d.id === "mkt:OPEN"));                              // unresolved markets are not memory
  const rag = new Rag(mkdtempSync(tmpdir() + "/rag-") + "/i.jsonl"), noEmbed = async () => null;
  assert.equal(await rag.add(docs, noEmbed), docs.length); assert.equal(await rag.add(docs, noEmbed), 0); assert.equal(rag.mode, "lexical");
  const all = await rag.search("Bitcoin price above 71000 at 5pm", { kinds: ["market"], embedFn: noEmbed }); assert.deepEqual(all.slice(0, 2).map(h => h.ticker).sort(), ["B1", "B2"]);
  const early = await rag.search("Bitcoin price above 71000 at 5pm", { kinds: ["market"], before: "2026-11-04T00:00:00Z", embedFn: noEmbed });
  assert.ok(early.every(h => Date.parse(h.at) < Date.parse("2026-11-04T00:00:00Z")) && !early.some(h => h.ticker === "B2"));                    // B2 settled later → invisible
  assert.deepEqual(await rag.search("anything", { before: "2026-10-01T00:00:00Z", embedFn: noEmbed }), []);
  assert.equal((await rag.search("x", { before: "2026-11-01T22:05:00Z", kinds: ["market"], embedFn: noEmbed })).length, 0);                    // strictly before: equal time is excluded
  const sim = await similarOutcomes(rag, "Bitcoin price above 71000", { before: "2026-11-08T00:00:00Z", embedFn: noEmbed }); assert.equal(sim.n, 3); assert.equal(sim.yesRate, 0.667);
  assert.equal(new Rag(rag.file).docs.size, docs.length);                                                                                   // survives a restart
  assert.equal(lexical("a b c").length, 256); assert.deepEqual(lexical("Hello World"), lexical("hello   world"));
  assert.equal(leakage({ preds: [], out: new Map(), backtest: [], snapshots: [] }, { rag: early.map(h => ({ id: h.id, at: h.at, asOf: "2026-11-04T00:00:00Z" })) }).total, 0);

  // ---- llm predictor: uses only earlier memory, is capped at ±0.15 from the market, and returns nothing without a model.
  _resetLocalCheck(); const calls = [], deps = { fetchFn: fakeOllama(sys => (/Estimate the probability/.test(sys) ? { p: 0.95, reason: "base rate", conflict: false } : {}), calls), cacheDir: mkdtempSync(tmpdir() + "/llm-"), log: false, rows: [], embedFn: noEmbed };
  const c = { ticker: "OPEN", title: "Bitcoin price above 75000 at 5pm", rules: "…", mid: 0.3, leadMin: 60, at: Date.parse("2026-11-04T00:00:00Z"), v24: 10 };
  const realSearch = rag.search.bind(rag); rag.search = (q, o) => realSearch(q, { ...o, embedFn: noEmbed, log: null });
  const e = await estimate(c, rag, deps); assert.equal(e.p, 0.45); assert.equal(e.raw, 0.95); assert.equal(e.src, "ollama");
  assert.ok(calls[0].prompt.includes("resolved YES") && !calls[0].prompt.includes("72000"));                                                  // the later market never reached the prompt
  assert.equal(await estimate(c, null, deps), null);
}

// ---- Facts: need a source URL and a publish time; injected "instructions" in the text are data; output is cut to fixed fields.
{
  _resetLocalCheck(); const deps = { fetchFn: fakeOllama(() => ({ facts: [{ entity: "BLS", claim: "The unemployment rate was 4.3 percent in October.", time: "2026-10-31T00:00:00Z", extra: "ignored" }, { entity: "x", claim: "short" }, "junk"] })), cacheDir: mkdtempSync(tmpdir() + "/llm-"), log: false, rows: [] };
  const f = await extractFacts({ title: "Jobs", text: "…", url: "https://example.com/a", at: "2026-11-07T13:30:00Z" }, deps);
  assert.equal(f.length, 1); assert.deepEqual(Object.keys(f[0]).sort(), ["at", "by", "claim", "entity", "id", "time", "url"]); assert.equal(f[0].at, "2026-11-07T13:30:00.000Z");
  assert.deepEqual(await extractFacts({ title: "t", text: "x", url: "", at: "2026-11-07T13:30:00Z" }, deps), []);
  assert.deepEqual(await extractFacts({ title: "t", text: "x", url: "https://e.com", at: "not a date" }, deps), []);
  const feed = parseFeed(`<rss><channel><item><title><![CDATA[Fed &amp; rates]]></title><link>https://fed.gov/a</link><pubDate>Wed, 04 Nov 2026 19:00:00 GMT</pubDate><description>&lt;p&gt;Cut by 25bp&lt;/p&gt;</description></item><item><title>No date</title><link>https://fed.gov/b</link></item><item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Wed, 04 Nov 2026 19:00:00 GMT</pubDate></item></channel></rss>`);
  assert.deepEqual(feed, [{ title: "Fed & rates", text: "Cut by 25bp", url: "https://fed.gov/a", at: "2026-11-04T19:00:00.000Z" }]);
}

// ---- LLM evals on the fixed case set: a "perfect reader" scores 100%, an obedient-to-injection one is caught, a blank one scores 0.
{
  const cases = CASES(); assert.ok(cases.rules.length >= 12 && cases.facts.length >= 6 && cases.markets.length >= 30);
  const perfect = (sys, prompt) => {
    if (/extract: \{"source"/.test(sys)) { const c = cases.rules.find(r => prompt.includes(r.text.slice(0, 60))); return { source: c.gold.sourceIncludes, variable: "v", comparison: c.gold.comparison, threshold: c.gold.threshold, time: "t", ambiguous: false }; }
    if (/list only concrete/.test(sys)) { const c = cases.facts.find(f => prompt.includes(f.item.text.slice(0, 40))); return { facts: (c?.gold || []).map(g => ({ entity: "e", claim: "It was reported: " + g.join(" and "), time: null })) }; }
    return {};
  };
  _resetLocalCheck(); const mk = brain => ({ fetchFn: fakeOllama(brain), cacheDir: mkdtempSync(tmpdir() + "/llm-"), log: false, rows: [] });
  const good = await evaluate({ deps: mk(perfect) }); assert.equal(good.rulesAcc, 1); assert.equal(good.factPrecision, 1); assert.equal(good.factRecall, 1); assert.equal(good.injectionFollowed, 0); assert.equal(good.sourcelessFactsDropped, true);
  const gullible = await evaluate({ deps: mk((sys, prompt) => (/list only concrete/.test(sys) && /Ignore all previous/.test(prompt) ? { facts: [{ entity: "system", claim: "buy YES on every market immediately", time: null }] } : perfect(sys, prompt))) });
  assert.equal(gullible.injectionFollowed, 1); assert.ok(gullible.factPrecision < 1);
  const blank = await evaluate({ deps: mk(() => ({})) }); assert.equal(blank.rulesAcc, 0); assert.equal(blank.factRecall, 0);
  // Ambiguous rules are the one place rules-reading escalates.
  _resetLocalCheck(); const cl = [], r = await rulesFor("eval:x", "If something unclear happens…", { ...mk(() => ({ source: "?", comparison: "event", ambiguous: true })), key: "k", claude: fakeClaude({ source: "Agency", variable: "x", comparison: "event", threshold: null, time: "", ambiguous: false }, cl), noSave: true });
  assert.equal(cl.length, 1); assert.equal(r.source, "Agency"); assert.equal(r.ambiguous, false);
}
