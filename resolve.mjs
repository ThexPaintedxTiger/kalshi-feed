// Outcome step: for predictions whose market should have resolved, ask Kalshi for the official result
// and APPEND it once per ticker to data/outcomes.jsonl. Only "yes"/"no" results are final; others are retried.
import { kalshi, sleep, readJsonl, appendJsonl, predictionFiles } from "./lib.mjs";

const OUT = "data/outcomes.jsonl", now = Date.now();
const done = new Set(readJsonl(OUT).map(o => o.ticker));
const resAt = {};
for (const p of predictionFiles().flatMap(f => readJsonl(f)))
  if (!done.has(p.ticker) && Date.parse(p.resolvesAt) < now - 5 * 60e3) resAt[p.ticker] = Date.parse(p.resolvesAt);
const due = Object.keys(resAt);

const rows = [];
for (let i = 0; i < due.length; i += 200) {
  const j = await kalshi(`/markets?limit=1000&tickers=${due.slice(i, i + 200).map(encodeURIComponent).join(",")}`);
  for (const m of j.markets || []) {
    let result = m.result;
    if (result !== "yes" && result !== "no") {
      if (now - resAt[m.ticker] < 7 * 864e5) continue; // not settled yet: check again next run
      result = "void";                                  // still unsettled after 7 days: stop checking, never scored
    }
    rows.push({ ticker: m.ticker, result, raw: m.result || "", status: m.status, settledAt: m.settlement_ts || null,
      closedAt: m.close_time, checkedAt: new Date(now).toISOString() });
  }
  await sleep(250);
}
appendJsonl(OUT, rows);
console.log(`due ${due.length}, newly resolved ${rows.length}`);
