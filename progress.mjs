// Self-check: are we moving toward the goal? Reads the scorecard and logs, compares them with the goals in
// config.json, and writes progress.json with a status and a plain-English recommendation per goal.
// It never changes config.json: recommendations need the owner's approval.
import { config, readJsonl, appendJsonl, r4 } from "./lib.mjs";

// Status of one predictor against the edge goal.
export function predictorStatus(p, g) {
  const n = p.n, vs = p.brierVsMarket || {}, pk = p.picks || {}, money = pk.pnlPerContract || {};
  const need = g.minResolved - n, fmt = x => (x > 0 ? "+" : "") + x;
  if (n < g.minForTrend) return { status: "INSUFFICIENT", rec: `wait: ${n}/${g.minForTrend} resolved before any trend is readable` };
  const accurate = n >= g.minResolved && vs.hi < 0;
  const profitable = pk.n >= g.minPicks && money.lo > 0;
  if (accurate && profitable) return { status: "SUCCESS", rec: "beats the market and simulated picks are profitable after fees — candidate for a paper-trading review (no real money without owner approval)" };
  if (n >= g.minResolved && vs.lo > 0) return { status: "FAILURE_WORSE", rec: `worse than the market (${fmt(vs.mean)} Brier) — recommend turning it off in config.json` };
  if (n >= g.retireAfter && !accurate) return { status: "FAILURE_RETIRE", rec: `no measurable edge after ${n} resolved — recommend retiring this hypothesis` };
  if (accurate) return { status: "ACCURATE_NOT_PROFITABLE", rec: `more accurate than the market, but picks aren't proven (${pk.n || 0}/${g.minPicks} picks${pk.n ? `, P&L/contract ${money.mean}` : ""}) — keep collecting` };
  if (vs.mean < 0) return { status: "ON_TRACK", rec: `leaning better than the market (${fmt(vs.mean)}) — wait for ${Math.max(0, need)} more resolved` };
  return { status: "OFF_TRACK", rec: `not beating the market so far (${fmt(vs.mean)}) — wait for ${Math.max(0, need)} more resolved before judging` };
}

// Pipeline health. On a young system the run/prediction targets scale with hours since the first run.
export function health(sc, runs, preds, outcomes, g, now) {
  const day = 864e5, since = t => now - Date.parse(t) <= day;
  const first = runs.length ? Math.min(...runs.map(r => Date.parse(r.ts))) : now;
  const frac = Math.min(1, Math.max(0, (now - first) / day));
  const done = new Set(outcomes.map(o => o.ticker));
  const checks = {
    runsLast24h: { value: runs.filter(r => since(r.ts)).length, target: Math.floor(g.minRunsPerDay * frac) },
    newPredictionsLast24h: { value: preds.filter(p => since(p.ts)).length, target: Math.floor(g.minNewPerDay * frac) },
    leakage: { value: sc.excludedLeakage || 0, target: g.maxLeakage, max: true },
    unresolvedBacklog: { value: preds.filter(p => !done.has(p.ticker) && now - Date.parse(p.resolvesAt) > g.maxBacklogHours * 36e5).length, target: 0, max: true },
  };
  for (const c of Object.values(checks)) c.ok = c.max ? c.value <= c.target : c.value >= c.target;
  return { ok: Object.values(checks).every(c => c.ok), warmingUp: frac < 1, checks };
}

// Trend vs the last snapshot from an earlier day: more data and a narrower interval = progressing.
export function trend(cur, prev) {
  if (!prev) return "first snapshot";
  if (cur.n <= prev.n) return "no new resolved data since last snapshot";
  const parts = [`+${cur.n - prev.n} resolved`];
  if (prev.width != null && cur.width != null) parts.push(cur.width < prev.width ? "interval narrowing" : "interval not narrowing");
  if (prev.mean != null && cur.mean != null && Math.sign(prev.mean) !== Math.sign(cur.mean)) parts.push(`direction flipped (${prev.mean} → ${cur.mean})`);
  return parts.join(", ");
}

export function evaluate(sc, runs, preds, outcomes, goals, now, prevSnap, bt = null) {
  const predictors = {};
  const names = new Set([...Object.keys(sc.predictors || {}), ...Object.keys(bt?.predictors || {})]);
  for (const k of names) {
    if (k === "market") continue;
    const p = sc.predictors?.[k] || { n: 0, brierVsMarket: {}, picks: { n: 0 } };
    const off = config.predictors?.[k]?.on === false;                     // retired by the owner: keep its record, drop it from the goal
    const s = off ? { status: "RETIRED", rec: config.predictors[k].retired || "turned off in config.json" } : predictorStatus(p, goals.edge), vs = p.brierVsMarket || {};
    const snap = { n: p.n, mean: vs.mean ?? null, width: vs.hi != null && Number.isFinite(vs.hi) ? r4(vs.hi - vs.lo) : null };
    const b = bt?.predictors?.[k];
    predictors[k] = { ...s, n: p.n, brierVsMarket: vs.mean ?? null, picks: p.picks?.n || 0, trend: trend(snap, prevSnap?.predictors?.[k]), snap,
      backtest: b ? { n: b.n, brierVsMarket: b.brierVsMarket.mean, verdict: b.verdict, picks: b.picks.n, pnlPerContract: b.picks.pnlPerContract.mean } : null };
  }
  const h = health(sc, runs, preds, outcomes, goals.health, now);
  const st = Object.values(predictors).map(p => p.status).filter(s => s !== "RETIRED");
  const goal = st.includes("SUCCESS") ? "SUCCESS"
    : st.length && st.every(s => s.startsWith("FAILURE")) ? "ALL_HYPOTHESES_FAILED — add a new predictor"
    : "IN_PROGRESS";
  return { updated: new Date(now).toISOString(), goal, resolved: sc.resolved || 0, health: h, predictors,
    definitions: "SUCCESS = Brier better than market (95% interval < 0, n ≥ minResolved) AND simulated picks profitable after fees (95% interval > 0, ≥ minPicks). " +
      "FAILURE = clearly worse than market, or no edge after retireAfter resolved. Recommendations only; nothing changes without owner approval." };
}

export function run(ctx) {
  const now = Date.now(), today = new Date(now).toISOString().slice(0, 10), snaps = readJsonl("data/progress.jsonl");
  const prev = [...snaps].reverse().find(s => s.date < today), st = ctx.store;
  const out = ctx.emit("progress", evaluate(ctx.get("scorecard") || {}, st.runs, st.preds, st.outcomes, config.goals, now, prev, ctx.get("backtest-scorecard")));
  if (!snaps.some(s => s.date === today) && Object.keys(out.predictors).length)
    appendJsonl("data/progress.jsonl", [{ date: today, resolved: out.resolved, predictors: Object.fromEntries(Object.entries(out.predictors).map(([k, p]) => [k, p.snap])) }]);
  return `goal: ${out.goal}; health ${out.health.ok ? "OK" : "PROBLEM"}${out.health.warmingUp ? " (warming up)" : ""}; ` + Object.entries(out.predictors).map(([k, p]) => `${k}: ${p.status}`).join("; ");
}
if (import.meta.url === `file://${process.argv[1]}`) { const { makeCtx } = await import("./core/ctx.mjs"); console.log(run(makeCtx())); }
