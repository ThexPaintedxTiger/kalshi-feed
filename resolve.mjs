// Outcome step: for predictions whose market should have resolved, ask Kalshi for the official result
// and APPEND it once per ticker to data/outcomes.jsonl. Only "yes"/"no" results are final; others are retried.
// The live daemon gets most outcomes from settlement messages; this batch lookup is the fallback and the cloud path.
import { kalshi, sleep } from "./lib.mjs";

// Outcome row from a Kalshi market object, or null while it is still unsettled (void after 7 days: never scored).
export function outcomeRow(m, resolvesAtMs, now = Date.now(), via = "rest") {
  let result = m.result;
  if (result !== "yes" && result !== "no") { if (now - resolvesAtMs < 7 * 864e5) return null; result = "void"; }
  return { ticker: m.ticker, result, raw: m.result || "", status: m.status, settledAt: m.settlement_ts || null, closedAt: m.close_time, checkedAt: new Date(now).toISOString(), via };
}

export async function run(ctx, { tickers = null } = {}) {
  const now = Date.now(), s = ctx.store, resAt = {};
  for (const p of s.preds) if (!s.out.has(p.ticker) && (tickers ? tickers.includes(p.ticker) : Date.parse(p.resolvesAt) < now - 5 * 60e3)) resAt[p.ticker] = Date.parse(p.resolvesAt);
  const due = Object.keys(resAt), rows = [];
  for (let i = 0; i < due.length; i += 200) {
    const j = await kalshi(`/markets?limit=1000&tickers=${due.slice(i, i + 200).map(encodeURIComponent).join(",")}`);
    for (const m of j.markets || []) { const r = outcomeRow(m, resAt[m.ticker], now); if (r) rows.push(r); }
    await sleep(250);
  }
  s.append("outcomes", rows);
  ctx.fresh = (ctx.fresh || 0) + rows.length;
  return `resolve: due ${due.length}, newly resolved ${rows.length}`;
}
if (import.meta.url === `file://${process.argv[1]}`) { const { makeCtx } = await import("./core/ctx.mjs"); console.log(await run(makeCtx())); }
