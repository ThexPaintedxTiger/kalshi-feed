// Predictors shared by the live pipeline (predict.mjs) and the backtest (backtest.mjs), so both test the same ideas.
// Each takes a market snapshot c = { mid, ask, bid, series, at } and context ctx = { recall } and returns P(YES),
// using only information available at time c.at (no future information).
import { config, ev, r4, readJson, writeJson, appendJsonl } from "./lib.mjs";
import { features, predict } from "./nnlib.mjs";
import { features as calibFeatures, predict as calibPredict, FEATURES as CFEATS } from "./models/calib.mjs";
import { predict as ensPredict } from "./models/ensemble.mjs";

// Trained network (data/nn/model.json), loaded once. Safety gate: while its walk-forward test on unseen markets says
// "worse than market", it stands down and returns the market price (no picks); it keeps retraining hourly and comes back
// on its own once that stops being true.
let MODEL;
const gate = f => (f?.model && !/^worse/.test(f.oos?.verdict || "") ? f.model : null);
const model = () => (MODEL === undefined ? (MODEL = gate(readJson("state/nn-model.json", null))) : MODEL);
export const setModel = f => { MODEL = gate(f); };              // called after each training run (long-running process)


export const PRED = {
  market: c => c.mid,
};

// nn needs c.cat and c.resolvesAt as well.
// Outside-data predictors: only where an outside estimate exists for this market (null = not scored here).
PRED.crypto_fair = c => c.ext?.crypto?.p ?? null;
PRED.weather_idx = c => (c.ext?.weather?.src === "nws-index" ? c.ext.weather.p : null);   // rebuilt on the index member stations (the old single-station weather_nws is gone)
PRED.ladder = c => c.ext?.ladder?.p ?? null;                 // only for markets in a multi-strike event
PRED.llm = c => c.ext?.llm?.p ?? null;                       // language-model estimate (only where one was made)
PRED.ensemble = () => null;                                   // computed in estimate() from the other models

// calib and ensemble read their weights from state/ (set in memory after each refit in a long-running process).
let CALIB, ENS;
export const setCalib = f => { CALIB = f?.w?.length === CFEATS.length ? f : null; };
export const setEnsemble = f => { ENS = f?.w ? f : null; };
const calibW = () => (CALIB === undefined ? (setCalib(readJson("state/calib.json", null)), CALIB) : CALIB);
const ensW = () => (ENS === undefined ? (setEnsemble(readJson("state/ensemble.json", null)), ENS) : ENS);
PRED.calib = (c, ctx) => { const m = calibW(); return m ? calibPredict(m.w, calibFeatures(c, ctx?.recall), c.mid, m.maxDev) : c.mid; };
PRED.nn = (c, ctx) => { const m = model(), x = features(c, ctx?.recall); return m && m.W[0][0].length === x.length ? predict(m, x, c.mid) : c.mid; };

// Runtime switch-offs made by the anomaly guard (data/overrides.json, committed with the logs so every runner sees them).
// config.json stays the reviewed setting; an override only ever turns something OFF, and is logged in data/decisions.jsonl.
const OVR = "data/overrides.json";
let overrides = readJson(OVR, { off: {} });
export function disable(k, why, now = Date.now()) {
  if (overrides.off[k] || !config.predictors[k]?.on) return false;
  overrides.off[k] = { at: new Date(now).toISOString(), why };
  writeJson(OVR, overrides);
  appendJsonl("data/decisions.jsonl", [{ ts: new Date(now).toISOString(), cfg: config.version, decision: `${k} switched off automatically`, why, evidence: "anomaly guard (live scorecard)", undo: `remove "${k}" from data/overrides.json` }]);
  return true;
}
export const enabled = () => Object.keys(PRED).filter(k => config.predictors[k]?.on && !overrides.off[k]);

// All enabled estimates for one snapshot, plus a simulated pick when expected value after fees clears the threshold.
export function estimate(c, ctx, skip = []) {
  const est = {}, picks = {};
  const names = enabled().filter(k => !skip.includes(k)), raws = {};
  for (const k of names) if (k !== "ensemble") raws[k] = PRED[k](c, ctx);
  if (names.includes("ensemble")) { const E = ensW(); raws.ensemble = E ? ensPredict(E, Object.fromEntries(Object.entries(raws).filter(([, v]) => v != null)), c.mid) : c.mid; }
  for (const k of names) {
    const raw = raws[k]; if (raw == null) continue;
    const p = r4(raw), e = ev(p, c.ask, c.bid);
    est[k] = p;
    const side = e.yes >= e.no ? "yes" : "no", edge = Math.max(e.yes, e.no);
    if (edge >= config.picks.minEdge) picks[k] = { side, ev: r4(edge), cost: side === "yes" ? c.ask : r4(1 - c.bid) };
  }
  return { est, picks };
}
