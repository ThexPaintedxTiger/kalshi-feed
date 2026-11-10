// Predictors shared by the live pipeline (predict.mjs) and the backtest (backtest.mjs), so both test the same ideas.
// Each takes a market snapshot c = { mid, ask, bid, series, at } and context ctx = { recall } and returns P(YES),
// using only information available at time c.at (no future information).
import { config, ev, r4, readJson } from "./lib.mjs";
import { features, predict } from "./nnlib.mjs";

let MODEL; // trained network (data/nn/model.json), loaded once; absent → the nn predictor returns the market price
const model = () => (MODEL ??= readJson("data/nn/model.json", null)?.model || null);

const logit = p => Math.log(p / (1 - p)), sigm = x => 1 / (1 + Math.exp(-x));
const clamp = p => Math.min(0.99, Math.max(0.01, p));

export const PRED = {
  market: c => c.mid,
  longshot: c => sigm(config.predictors.longshot.slope * logit(c.mid)),
  // Memory: shift the price by this series' own past (outcome − price) gap, shrunk toward 0 when there's little history.
  memory: (c, ctx) => {
    const P = config.predictors.memory, s = ctx?.recall?.(c.series, c.at);
    if (!s || s.n < P.minN) return c.mid;
    return clamp(c.mid + (s.n / (s.n + P.shrink)) * s.bias);
  },
};

// nn needs c.cat and c.resolvesAt as well.
PRED.nn = (c, ctx) => { const m = model(); return m ? predict(m, features(c, ctx?.recall), c.mid) : c.mid; };

export const enabled = () => Object.keys(PRED).filter(k => config.predictors[k]?.on);

// All enabled estimates for one snapshot, plus a simulated pick when expected value after fees clears the threshold.
export function estimate(c, ctx, skip = []) {
  const est = {}, picks = {};
  for (const k of enabled().filter(k => !skip.includes(k))) {
    const p = r4(PRED[k](c, ctx)), e = ev(p, c.ask, c.bid);
    est[k] = p;
    const side = e.yes >= e.no ? "yes" : "no", edge = Math.max(e.yes, e.no);
    if (edge >= config.picks.minEdge) picks[k] = { side, ev: r4(edge), cost: side === "yes" ? c.ask : r4(1 - c.bid) };
  }
  return { est, picks };
}
