// Leakage eval: automated checks that nothing from the future reached a prediction or a training set. Total must be 0.
// "Future" = after the moment the row was made, or after the market resolved.
export function leakage(store, { walk = {}, rag = [], facts = [] } = {}) {
  const checks = [], add = (name, bad, of, detail = "") => checks.push({ name, violations: bad.length, of, examples: bad.slice(0, 3), detail });
  const ms = s => Date.parse(s), SLACK = 5 * 60e3;                              // a row's outside data is fetched seconds after its `ts`
  const preds = store.preds;
  add("prediction logged before its market resolved", preds.filter(p => { const o = store.out.get(p.ticker); return ms(p.ts) >= Math.min(ms(p.resolvesAt), ms(o?.settledAt || p.resolvesAt), ms(o?.closedAt || p.resolvesAt)) && (o?.result === "yes" || o?.result === "no"); }).map(p => p.ticker), preds.length, "scored rows exclude these");
  const ext = preds.flatMap(p => Object.values(p.ext || {}).map(e => ({ p, at: ms(e.at) }))).filter(x => Number.isFinite(x.at));
  add("outside data timestamped at or before the prediction", ext.filter(x => x.at > ms(x.p.loggedAt || x.p.ts) + (x.p.loggedAt ? 0 : SLACK) || x.at >= ms(x.p.resolvesAt)).map(x => x.p.ticker), ext.length);
  const bt = store.backtest;
  add("backtest snapshot taken before resolution", bt.filter(r => ms(r.ts) >= Math.min(ms(r.resolvesAt), ms(r.settledAt || r.resolvesAt))).map(r => r.ticker), bt.length);
  const sn = store.snapshots;
  add("minute snapshot taken at its lead time, before resolution", sn.filter(r => ms(r.ts) >= ms(r.resolvesAt) || ms(r.ts) < ms(r.resolvesAt) - (r.leadMin + 2) * 6e4).map(r => `${r.ticker}|${r.leadMin}`), sn.length);
  add("walk-forward training rows known before the test block", Array.from({ length: Object.values(walk).reduce((s, n) => s + n, 0) }, (_, i) => "row" + i), Object.keys(walk).length, Object.entries(walk).map(([k, n]) => `${k}: ${n}`).join(", "));
  add("retrieved memory dated before the prediction", rag.filter(h => ms(h.at) >= ms(h.asOf)).map(h => h.id), rag.length);
  add("news facts dated before the prediction", facts.filter(f => ms(f.at) >= ms(f.asOf)).map(f => f.id), facts.length);
  return { at: new Date().toISOString(), total: checks.reduce((s, c) => s + c.violations, 0), checks };
}
