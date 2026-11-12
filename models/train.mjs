// Training orchestration.
//   onSettle(ctx)  every settlement: refit calib (milliseconds, warm start) and fine-tune the network from its current weights.
//   hourly(ctx)    full walk-forward runs (network + calib), the stacked ensemble, and the development evidence shown on
//                  the model cards. Walk-forward = every test market is predicted by a model that only saw markets whose
//                  outcome was already known at that time.
import { config, r4 } from "../lib.mjs";
import { clustered } from "../score.mjs";
import * as calib from "./calib.mjs";
import * as ensemble from "./ensemble.mjs";
import * as nn from "../nn.mjs";
import { setCalib, setEnsemble, setModel } from "../predictors.mjs";
import { train as nnTrain } from "../nnlib.mjs";

export function onSettle(ctx) {
  const msg = calib.run(ctx); setCalib(ctx.get("calib", "state"));
  const f = ctx.get("nn-model", "state");
  if (f?.model && Date.now() - (ctx.nnTuned || 0) > 5 * 6e4) {                    // warm-start fine-tune, at most every 5 minutes
    const ds = nn.dataset(ctx.store, ctx.recall);
    if (ds.data.length > (f.tunedN ?? f.n) && ds.data[0].x.length === f.model.W[0][0].length) {
      const N = config.nn, r = nnTrain(ds.data, { hidden: N.hidden, lr: N.lr / 3, l2: N.l2, batch: N.batch, epochs: 2, seed: N.seed, valFrac: 0, extra: ds.extra, init: f.model });
      ctx.emit("nn-model", { ...f, model: r.model, tunedN: ds.data.length, tuned: new Date().toISOString() }, "state"); setModel(ctx.get("nn-model", "state")); ctx.nnTuned = Date.now();
    }
  }
  return msg;
}

const devStat = (rows, oos) => { const te = rows.filter(r => r.primary && oos[r.ticker] != null), c = clustered(te, r => (oos[r.ticker] - r.y) ** 2 - (r.mid - r.y) ** 2);
  return { what: "walk-forward on past markets (development evidence, not the verdict)", n: te.length, events: c.events, brierVsMarket: c.mean, lo: c.lo, hi: c.hi }; };

export function hourly(ctx, { force = false } = {}) {
  const out = [nn.run(ctx, { force })];
  const rows = calib.trainingRows(ctx.store, ctx.recall), sig = `${rows.length}|${config.version}`;
  if (!force && ctx.hourlySig === sig && ctx.get("ensemble", "state")) return out.concat("models: no new settled markets — walk-forward skipped").join("\n");
  ctx.hourlySig = sig;
  const M = config.models, wf = calib.walkForward(rows, { l2: M.calib.l2, maxDev: M.calib.maxDev });
  ctx.walkLeaks = { calib: wf.leaks };
  const nnOos = ctx.get("nn-oos", "state") || {}, cf = {};
  for (const p of ctx.store.preds) if (p.est?.crypto_fair != null) cf[p.ticker] = p.est.crypto_fair;      // logged before resolution → out-of-sample by construction
  for (const r of ctx.store.backtest) if (r.est?.crypto_fair != null && !(r.ticker in cf)) cf[r.ticker] = r.est.crypto_fair;
  const oos = { calib: wf.oos, nn: nnOos, crypto_fair: cf };
  const E = ensemble.run(ctx, rows, oos); setEnsemble(E);
  const data = rows.filter(r => r.primary && E.members.some(k => oos[k]?.[r.ticker] != null)).map(r => ({ est: Object.fromEntries(E.members.map(k => [k, oos[k]?.[r.ticker]]).filter(([, v]) => v != null)), mid: r.mid, y: r.y, ticker: r.ticker, t: r.t, known: r.known }));
  const eOos = ensemble.walkForward(data, E.members, { l2: M.ensemble.l2, maxDev: M.ensemble.maxDev });
  ctx.emit("dev", { at: new Date().toISOString(), calib: devStat(rows, wf.oos), nn: devStat(rows, nnOos), ensemble: devStat(rows, eOos), crypto_fair: devStat(rows, cf) }, "state");
  calib.run(ctx); setCalib(ctx.get("calib", "state"));
  const d = ctx.out.dev;
  out.push(`models: walk-forward vs market — calib ${fmt(d.calib)}, ensemble ${fmt(d.ensemble)}, nn ${fmt(d.nn)}; ensemble weights ${JSON.stringify(E.weights || {})}; training leaks ${wf.leaks}`);
  return out.filter(Boolean).join("\n");
}
const fmt = d => `${d.brierVsMarket > 0 ? "+" : ""}${d.brierVsMarket} (${d.lo}…${d.hi}, n=${d.n})`;
