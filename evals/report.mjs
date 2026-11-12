// The referee. Builds site/evals.json from the LIVE record only (each estimate was logged before its market resolved, by
// a model trained on markets that had already settled). For every predictor:
//   - Brier and log loss vs the market on the same markets, per event (clustered 95% snapshot interval — NOT peeking-safe)
//   - the peeking-safe verdict: a confidence sequence on the per-event Brier difference, alpha split across every
//     predictor and variant ever tried; and the same for simulated picks' P&L after fees
//   - breakdowns by category and by lead time, calibration curve, biggest misses, model card
// SUCCESS = sequence upper bound < 0 on ≥ minResolved markets AND picks' P&L sequence lower bound > 0 on ≥ minPicks picks.
// Nothing here is tuned on: settings were frozen at config.evals.frozenAt.
import { config, r4, fee } from "../lib.mjs";
import { clustered, brier, logLoss, pnl } from "../score.mjs";
import { seqVerdict } from "./seq.mjs";
import { leakage } from "./leakage.mjs";

const HYP = k => config.predictors[k]?.hypothesis || "";
export function family() { return Math.max(1, Object.keys(config.predictors).filter(k => k !== "market").reduce((s, k) => s + (config.models?.[k]?.variantsTried || 1), 0)); }

export function evaluateModel(k, rows, { alpha, G = config.goals.edge, maxDev = null } = {}) {
  const rs = rows.filter(r => r.est?.[k] != null && r.est.market != null), order = r => r.known;
  const d = r => brier(r.est[k], r.y) - brier(r.est.market, r.y), bound = maxDev ? 2 * maxDev : 1;
  const seq = seqVerdict(rs.map(r => ({ event: r.event, order: order(r), v: Math.max(-bound, Math.min(bound, d(r))) })), { alpha, lo: -bound, hi: bound });
  const pk = rs.filter(r => r.picks?.[k]), money = seqVerdict(pk.map(r => ({ event: r.event, order: order(r), v: pnl(r.picks[k], r.y) })), { alpha, lo: -1.07, hi: 1 });
  const snap = clustered(rs, d), ll = clustered(rs, r => logLoss(r.est[k], r.y) - logLoss(r.est.market, r.y)), same = rs.length > 0 && rs.every(r => r.est[k] === r.est.market);
  const n = rs.length, off = config.predictors[k]?.on === false;
  const accurate = n >= G.minResolved && seq.hi < 0, worse = n >= G.minResolved && seq.lo > 0, profitable = pk.length >= G.minPicks && money.lo > 0;
  const status = off ? "RETIRED" : n < G.minForTrend ? "INSUFFICIENT" : same ? "SAME_AS_MARKET" : accurate && profitable ? "SUCCESS" : worse ? "FAILURE_WORSE"
    : n >= G.retireAfter && !accurate ? "NO_EDGE" : accurate ? "ACCURATE_NOT_PROFITABLE" : snap.mean < 0 ? "ON_TRACK" : "OFF_TRACK";
  const by = (key, label) => { const g = {}; for (const r of rs) (g[key(r)] ||= []).push(r); return Object.entries(g).map(([name, a]) => ({ [label]: name, n: a.length, ...pick(clustered(a, d)) })).sort((a, b) => b.n - a.n); };
  const pick = c => ({ diff: c.mean, lo: c.lo, hi: c.hi, events: c.events });
  const LB = config.evals.leadBuckets, lead = r => { const m = r.leadMin ?? 0, i = LB.findIndex(b => m <= b); return i < 0 ? `>${LB.at(-1)} min` : `≤${LB[i]} min`; };
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 })); for (const r of rs) { const b = bins[Math.min(9, Math.floor(r.est[k] * 10))]; b.n++; b.p += r.est[k]; b.y += r.y; }
  return { model: k, status, n, events: seq.n, picks: pk.length,
    brier: r4(rs.reduce((s, r) => s + brier(r.est[k], r.y), 0) / (n || 1)), brierMarket: r4(rs.reduce((s, r) => s + brier(r.est.market, r.y), 0) / (n || 1)),
    vsMarket: { snapshot95: pick(snap), logLoss: pick(ll), sequence: { lo: seq.lo, hi: seq.hi, mean: seq.mean, alpha: seq.alpha, bound, note: "valid however often it is looked at" } },
    money: { n: pk.length, wins: pk.filter(r => pnl(r.picks[k], r.y) > 0).length, total: r4(pk.reduce((s, r) => s + pnl(r.picks[k], r.y), 0)), perPick: money.mean, sequence: { lo: money.lo, hi: money.hi } },
    byCategory: by(r => r.cat || "?", "cat"), byLead: by(lead, "lead"),
    calibration: bins.map((b, i) => b.n ? { bin: `${i * 10}–${i * 10 + 10}%`, n: b.n, said: r4(b.p / b.n), happened: r4(b.y / b.n) } : null).filter(Boolean),
    misses: rs.map(r => ({ r, loss: logLoss(r.est[k], r.y) - logLoss(r.est.market, r.y) })).sort((a, b) => b.loss - a.loss).slice(0, 5).map(({ r, loss }) => ({ ticker: r.ticker, title: r.title, said: r.est[k], market: r.est.market, outcome: r.y ? "yes" : "no", worseBy: r4(loss) })),
    why: off ? (config.predictors[k].retired || "switched off") : status === "SUCCESS" ? "beats the market on the peeking-safe test and its picks are profitable after fees"
      : `needs: ${n < G.minResolved ? `${G.minResolved - n} more resolved markets; ` : ""}${!(seq.hi < 0) ? `whole peeking-safe range below 0${seq.hi == null ? "" : ` (upper end now ${seq.hi > 0 ? "+" : ""}${r4(seq.hi)})`}; ` : ""}${pk.length < G.minPicks ? `${G.minPicks - pk.length} more picks; ` : ""}${!(money.lo > 0) ? `picks' P&L range above 0${money.lo == null ? "" : ` (lower end now ${r4(money.lo)})`}` : ""}` };
}

// Model cards: what each model is, what it learned from, and what would change the verdict.
function card(k, ev, ctx) {
  const cal = ctx.get("calib", "state"), nn = ctx.get("nn-model", "state"), ens = ctx.get("ensemble", "state"), dev = ctx.get("dev", "state")?.[k];
  const base = { model: k, hypothesis: HYP(k), verdict: ev?.status || "INSUFFICIENT", n: ev?.n || 0, development: dev || null,
    wouldChange: ev?.status === "SUCCESS" ? "a sequence bound crossing back over 0 demotes it" : "the peeking-safe sequence excluding 0 on ≥ " + config.goals.edge.minResolved + " live markets, plus profitable picks" };
  if (k === "calib") return { ...base, kind: "logistic market correction (Newton, L2 toward the market)", data: cal?.sources || null, trainedOn: cal?.rows || 0, trained: cal?.trained || null, features: cal?.features || [], weights: cal?.w || null, limits: `±${config.models.calib.maxDev} from the market` };
  if (k === "nn") return { ...base, kind: `neural network ${JSON.stringify(nn?.architecture || [])}, residual on the market, gated`, data: nn?.sources || null, trainedOn: nn?.n || 0, trained: nn?.trained || null, features: nn?.features || [], gate: nn?.oos?.verdict || "not tested", limits: "returns the market price while its walk-forward test says 'worse'" };
  if (k === "ensemble") return { ...base, kind: "stacked logistic blend", data: { rows: ens?.n || 0 }, trainedOn: ens?.n || 0, trained: ens?.trained || null, features: ens?.members || [], weights: ens?.weights || null, limits: `±${config.models.ensemble.maxDev} from the market` };
  if (k === "crypto_fair") return { ...base, kind: "random-walk fair value from Coinbase spot and 1-minute volatility", data: "outside data, no training", trainedOn: 0, features: ["spot", "σ per minute", "minutes left", "strike"], limits: "approximates Kalshi's CF Benchmarks settlement index" };
  return { ...base, kind: config.predictors[k]?.on === false ? "retired" : "rule", data: null, trainedOn: 0, features: [] };
}

export function run(ctx, extra = {}) {
  const s = ctx.store, rows = [];
  for (const p of s.preds) { const y = s.result(p.ticker); if (y == null) continue; const o = s.out.get(p.ticker), t = Date.parse(p.ts);
    if (t >= Math.min(Date.parse(p.resolvesAt), Date.parse(o.settledAt || p.resolvesAt), Date.parse(o.closedAt || p.resolvesAt))) continue;      // leakage guard
    rows.push({ ...p, y, known: Date.parse(o.settledAt || p.resolvesAt) }); }
  const fam = family(), alpha = config.evals.alpha / fam, names = [...new Set(rows.flatMap(r => Object.keys(r.est)))].filter(k => k !== "market");
  for (const k of Object.keys(config.predictors)) if (k !== "market" && !names.includes(k)) names.push(k);
  const models = {}; for (const k of names) models[k] = evaluateModel(k, rows, { alpha, maxDev: config.models?.[k]?.maxDev ?? null });
  // Controls: the same test applied to a coin flip buying at the quoted price, so "after fees" has a reference.
  const coin = rows.map(r => { const side = (r.ticker.length + r.ticker.charCodeAt(r.ticker.length - 1)) % 2 ? "yes" : "no", cost = side === "yes" ? r.ask : r4(1 - r.bid); return { event: r.event, order: r.known, v: (side === "yes" ? r.y : 1 - r.y) - cost - fee(cost) }; });
  const coinSeq = seqVerdict(coin, { alpha, lo: -1.07, hi: 1 });
  const market = { n: rows.length, events: new Set(rows.map(r => r.event)).size, brier: r4(rows.reduce((t, r) => t + brier(r.est.market, r.y), 0) / (rows.length || 1)) };
  const leak = leakage(s, extra.leak || { walk: ctx.walkLeaks || {} });
  const success = Object.values(models).filter(m => m.status === "SUCCESS").map(m => m.model);
  return ctx.emit("evals", { at: new Date().toISOString(), cfg: config.version, alpha: config.evals.alpha, family: fam, alphaEach: alpha, frozenAt: config.evals.frozenAt, note: config.evals.note,
    market, controls: { cash: { perPick: 0 }, coinFlip: { n: coin.length, perPick: coinSeq.mean, sequence: { lo: coinSeq.lo, hi: coinSeq.hi } } },
    models, cards: Object.fromEntries(names.map(k => [k, card(k, models[k], ctx)])), leakage: leak, success,
    headline: success.length ? `${success.join(", ")} passed the peeking-safe test: paper-trade candidate. Real money still needs the owner's yes.`
      : `Nothing beats the market. ${rows.length} live markets resolved; the market's own Brier is ${market.brier}. Best so far: ${best(models)}.` });
}
const best = models => { const a = Object.values(models).filter(m => m.status !== "RETIRED" && m.n >= 20).sort((x, y) => x.vsMarket.snapshot95.diff - y.vsMarket.snapshot95.diff)[0]; return a ? `${a.model} ${a.vsMarket.snapshot95.diff > 0 ? "+" : ""}${a.vsMarket.snapshot95.diff} Brier vs market (not significant)` : "no model has 20 resolved yet"; };
