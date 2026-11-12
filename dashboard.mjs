// Builds site/app.json: one compact file with everything dashboard.html shows. Code only, no network.
import { config, readJsonl, readJson, r4, marketUrl } from "./lib.mjs";

const thin = (a, n) => !a || a.length <= n ? a || [] : a.filter((_, i) => i % Math.ceil(a.length / n) === 0 || i === a.length - 1);
const lastLines = (file, n) => { try { return readJsonl(file).slice(-n); } catch { return []; } };

export function run(ctx) {
  const now = Date.now(), st = ctx.store, catMap = readJson("data/series.json", { map: {} }).map, catOf = p => p.cat || catMap[p.series] || "";
  const outcome = p => { const o = st.out.get(p.ticker); return o ? o.result : Date.parse(p.resolvesAt) < now ? "awaiting" : "open"; };
  const paper = ctx.get("paper"), slimPf = p => ({ id: p.id, name: p.name, predictor: p.predictor, equity: p.equity, returnPct: p.returnPct, bets: p.bets, settled: p.settled, wins: p.wins, pnl: p.pnl, fees: p.fees,
    maxDrawdownPct: p.maxDrawdownPct, open: p.openPositions, why: p.trustNow?.why || null, curve: thin(p.curve, 120), recent: (p.recent || []).slice(0, 6).map(b => ({ ts: b.ts, ticker: b.ticker, title: b.title, side: b.side, price: b.price, stake: b.stake, pnl: b.pnl, shadow: !!b.shadow })) });
  const upd = lastLines(`data/updates/${new Date(now).toISOString().slice(0, 7)}.jsonl`, 3000), updBy = {};
  for (const u of upd) (updBy[u.ticker] ||= []).push([u.ts, u.mid, u.est]);
  const recent = st.preds.slice(-300).reverse();
  const perf = lastLines("state/perf.jsonl", 200);
  const app = {
    generated: new Date(now).toISOString(), cfg: config.version, repo: "ThexPaintedxTiger/kalshi-feed",
    goals: config.goals.edge, predictors: Object.fromEntries(Object.entries(config.predictors).map(([k, v]) => [k, { on: !!v.on, hypothesis: v.hypothesis, retired: v.retired || null }])),
    status: ctx.get("status"), evals: ctx.get("evals"), goal: ctx.get("progress")?.goal, health: ctx.get("progress")?.health,
    trend: lastLines("data/progress.jsonl", 60), dev: ctx.get("dev", "state"), ensemble: (e => e && { weights: e.weights || null, n: e.n, status: e.status, trained: e.trained })(ctx.get("ensemble", "state")),
    backtest: (b => b && { resolved: b.resolved, events: b.events, window: b.window, sampleCheck: b.sampleCheck, predictors: Object.fromEntries(Object.entries(b.predictors).map(([k, v]) => [k, { n: v.n, vs: v.brierVsMarket }])) })(ctx.get("backtest-scorecard")),
    paper: paper && { updated: paper.updated, start: paper.start, goal: paper.goal, note: paper.note, forward: { rows: paper.forward.rows, settled: paper.forward.settled, portfolios: paper.forward.portfolios.map(slimPf) },
      replay: { rows: paper.replay.rows, portfolios: paper.replay.portfolios.map(p => ({ id: p.id, name: p.name, equity: p.equity, bets: p.bets, maxDrawdownPct: p.maxDrawdownPct })) }, maker: ctx.get("maker") || null },
    totals: { predictions: st.preds.length, outcomes: st.out.size, backtest: st.backtest.length, snapshots: st.snapshots.length, runs: st.runs.length },
    predictions: recent.map(p => ({ ts: p.ts, k: p.ticker, title: p.title, cat: catOf(p), res: p.resolvesAt, lead: p.leadMin, a: p.ask, b: p.bid, mid: p.mid, est: p.est, picks: p.picks && Object.keys(p.picks).length ? p.picks : undefined, out: outcome(p), url: marketUrl(p.series),
      ext: p.ext ? Object.fromEntries(Object.entries(p.ext).map(([k, v]) => [k, { p: v.p, src: v.src, at: v.at }])) : undefined, upd: updBy[p.ticker]?.slice(-40) })),
    facts: ctx.get("facts", "state")?.recent || [],
    ops: { heartbeat: ctx.get("heartbeat"), storage: ctx.get("storage"), external: ctx.get("external", "state"), llm: ctx.get("llm-usage", "state"), alerts: ctx.get("alerts"), rag: ctx.get("rag-stats", "state"),
      perf: { last: ctx.perf || perf.at(-1) || null, cycles: thin(perf.filter(p => p.kind === "cycle" || p.kind === "derive").map(p => [p.ts, p.ms, p.rssMB]), 60), settles: thin(perf.filter(p => p.kind === "settle").map(p => [p.ts, p.ms]), 60) },
      runs: st.runs.slice(-60).map(r => [r.ts, r.logged, r.run]), llmEval: ctx.get("llm-eval", "state") },
    briefings: lastLines("data/briefing.jsonl", 5).reverse(), decisions: lastLines("data/decisions.jsonl", 12).reverse(),
  };
  ctx.emit("app", app);
  return `app.json: ${st.preds.length} predictions, ${Object.keys(app.evals?.models || {}).length} models`;
}
if (import.meta.url === `file://${process.argv[1]}`) { const { makeCtx } = await import("./core/ctx.mjs"); console.log(run(makeCtx())); }
