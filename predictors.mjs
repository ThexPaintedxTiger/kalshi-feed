// Predictors shared by the live pipeline (predict.mjs) and the backtest (backtest.mjs), so both test the same ideas.
// Each takes a market snapshot c = { mid, ask, bid, series, at } and context ctx = { recall } and returns P(YES),
// using only information available at time c.at (no future information).
import { config, ev, r4, readJson } from "./lib.mjs";
import { features, predict } from "./nnlib.mjs";

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
PRED.weather_nws = c => c.ext?.weather?.p ?? null;

PRED.nn = (c, ctx) => { const m = model(), x = features(c, ctx?.recall); return m && m.W[0][0].length === x.length ? predict(m, x, c.mid) : c.mid; };

export const enabled = () => Object.keys(PRED).filter(k => config.predictors[k]?.on);

// All enabled estimates for one snapshot, plus a simulated pick when expected value after fees clears the threshold.
export function estimate(c, ctx, skip = []) {
  const est = {}, picks = {};
  for (const k of enabled().filter(k => !skip.includes(k))) {
    const raw = PRED[k](c, ctx); if (raw == null) continue;
    const p = r4(raw), e = ev(p, c.ask, c.bid);
    est[k] = p;
    const side = e.yes >= e.no ? "yes" : "no", edge = Math.max(e.yes, e.no);
    if (edge >= config.picks.minEdge) picks[k] = { side, ev: r4(edge), cost: side === "yes" ? c.ask : r4(1 - c.bid) };
  }
  return { est, picks };
}
