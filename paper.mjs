// Paper trading: several $10 portfolios, each with its own strategy, trade the agent's predictions with realistic costs
// (buy YES at the ask or NO at 1 − bid, Kalshi taker fee per order rounded up to the cent, cash locked until settlement).
// Two modes:
//   replay  — past settled markets from the backtest, in time order. The neural net only trades on its walk-forward
//             (out-of-sample) predictions, so it never trades a market it trained on.
//   forward — live predictions logged before resolution (config v4+). This is the record that counts.
// Then a Monte Carlo resamples each strategy's per-bet returns to estimate its chance of turning $10 into $1,000.
// SIMULATION ONLY. Nothing is traded. Derived from the logs each run (data/paper/portfolios.json).
import { config, readJson, readJsonl, writeJson, r4, hash } from "./lib.mjs";
import { allPredictions, backtestRows } from "./memory.mjs";
import { rng } from "./nnlib.mjs";

const P = config.paper, excluded = new Set(config.scan.excludeCategories || []);
export const orderFee = (price, contracts) => Math.ceil(0.07 * contracts * price * (1 - price) * 100 - 1e-9) / 100;

// Kelly fraction for a binary contract bought at price c with win probability q, after the per-contract fee.
export const kellyFraction = (q, c, feePer = 0) => Math.max(0, (q - c - feePer) / (1 - c));

export function decide(pf, row) {
  if (!pf.predictor) return null;
  let side, p;
  if (pf.predictor === "coin") { side = hash(row.ticker + pf.id) % 2 ? "yes" : "no"; p = row.mid; }
  else {
    p = row.est?.[pf.predictor]; if (p == null) return null;
    const evYes = p - row.ask - orderFee(row.ask, 1), noCost = 1 - row.bid, evNo = (1 - p) - noCost - orderFee(noCost, 1);
    side = evYes >= evNo ? "yes" : "no";
    if (Math.max(evYes, evNo) < (pf.minEdge ?? 0.02)) return null;
  }
  const c = side === "yes" ? row.ask : r4(1 - row.bid), q = side === "yes" ? p : 1 - p;
  return { side, c, q };
}

export function simulate(pf, rows) {
  let cash = P.start, open = [], peak = P.start, maxDD = 0, reachedAt = null, busted = null;
  const bets = [], curve = [[rows[0] ? Date.parse(rows[0].ts) : Date.now(), P.start]];
  const equity = () => cash + open.reduce((s, o) => s + o.C * o.c, 0);
  const settle = until => {
    open.sort((a, b) => a.settle - b.settle);
    while (open.length && open[0].settle <= until) {
      const o = open.shift(), payout = o.win ? o.C : 0;
      cash += payout; o.bet.pnl = r4(payout - o.C * o.c - o.fee); o.bet.won = o.win;
      const e = equity(); curve.push([o.settle, r4(e)]);
      peak = Math.max(peak, e); maxDD = Math.max(maxDD, (peak - e) / peak);
      if (!reachedAt && e >= P.goal) reachedAt = new Date(o.settle).toISOString();
    }
  };
  for (const row of rows) {
    const t = Date.parse(row.ts); settle(t);
    if (busted) break;
    if (equity() < P.bustBelow && !open.length) { busted = new Date(t).toISOString(); break; }
    const d = decide(pf, row); if (!d) continue;
    const bank = equity(), feePer = orderFee(d.c, 1);
    const frac = pf.sizing === "kelly" ? Math.min(pf.maxFrac ?? 0.25, (pf.kelly ?? 0.25) * kellyFraction(d.q, d.c, feePer)) : (pf.frac ?? 0.05);
    let C = Math.min(frac * bank / d.c, P.maxContracts, P.maxDollarsPerBet / d.c);
    while (C > 0 && C * d.c + orderFee(d.c, C) > cash) C *= 0.95;           // can't spend money we don't have
    C = Math.floor(C * 100) / 100;
    if (C * d.c < 0.1) continue;                                             // too small to place
    const fee = orderFee(d.c, C); cash -= C * d.c + fee;
    const win = row.y == null ? null : (d.side === "yes" ? row.y === 1 : row.y === 0);
    const bet = { ts: row.ts, ticker: row.ticker, title: row.title, cat: row.cat, side: d.side, price: d.c, contracts: C, fee, bankroll: r4(bank), pnl: null, won: null };
    bets.push(bet);
    open.push({ settle: win == null ? Infinity : Date.parse(row.settledAt || row.resolvesAt), win, C, c: d.c, fee, bet });
  }
  settle(Date.now());
  const done = bets.filter(b => b.pnl != null);
  return { id: pf.id, name: pf.name, predictor: pf.predictor, equity: r4(equity()), cash: r4(cash), openPositions: open.length,
    returnPct: r4((equity() / P.start - 1) * 100), bets: bets.length, settled: done.length, wins: done.filter(b => b.won).length,
    pnl: r4(done.reduce((s, b) => s + b.pnl, 0)), fees: r4(bets.reduce((s, b) => s + b.fee, 0)), maxDrawdownPct: r4(maxDD * 100), busted, reachedGoal: reachedAt,
    returns: done.map(b => b.pnl / b.bankroll), curve: thin(curve, 200), recent: bets.slice(-15).reverse() };
}
const thin = (a, n) => a.length <= n ? a : a.filter((_, i) => i % Math.ceil(a.length / n) === 0 || i === a.length - 1);

// Bootstrap: draw past per-bet returns at random to build many possible futures for this strategy.
export function monteCarlo(returns, o = P.monteCarlo) {
  if (returns.length < 20) return null;
  const rand = rng(o.seed), hits = [], finals = [];
  let bust = 0;
  for (let p = 0; p < o.paths; p++) {
    let e = P.start, k = 0;
    for (; k < o.maxBets; k++) {
      e *= 1 + returns[Math.floor(rand() * returns.length)];
      if (e >= P.goal) { hits.push(k + 1); break; }
      if (e < P.bustBelow) { bust++; break; }
    }
    finals.push(e);
  }
  const g = returns.reduce((s, r) => s + Math.log(Math.max(1e-9, 1 + r)), 0) / returns.length;
  const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  return { paths: o.paths, maxBets: o.maxBets, pReachGoal: r4(hits.length / o.paths), pBust: r4(bust / o.paths), medianBetsToGoal: med(hits),
    medianFinal: r4(med(finals)), growthPerBet: r4(g), betsFor100x: g > 0 ? Math.ceil(Math.log(P.goal / P.start) / g) : null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const oos = readJson("data/nn/oos.json", {}), out = Object.fromEntries(readJsonl("data/outcomes.jsonl").map(o => [o.ticker, o]));
  const replay = backtestRows().filter(r => !excluded.has(r.cat)).map(r => ({ ...r, est: { ...r.est, nn: oos[r.ticker] } }))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const forward = allPredictions().filter(p => p.cfg >= 4 && !excluded.has(p.cat)).map(p => {
    const o = out[p.ticker], y = o?.result === "yes" ? 1 : o?.result === "no" ? 0 : null;
    return { ...p, y, settledAt: o?.settledAt || p.resolvesAt };
  }).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const run = rows => P.portfolios.map(pf => { const s = simulate(pf, rows); const mc = monteCarlo(s.returns); delete s.returns; return { ...s, monteCarlo: mc }; });
  const res = {
    updated: new Date().toISOString(), start: P.start, goal: P.goal,
    note: "SIMULATION ONLY — paper money, nothing is traded. Replay = past settled markets (supporting evidence; neural net uses out-of-sample predictions only). Forward = live predictions (the record that counts). Fills assume the quoted price; real fills on thin markets can be worse.",
    replay: { rows: replay.length, from: replay[0]?.ts || null, to: replay.at(-1)?.ts || null, portfolios: run(replay) },
    forward: { rows: forward.length, settled: forward.filter(r => r.y != null).length, portfolios: run(forward) },
  };
  writeJson("data/paper/portfolios.json", res);
  for (const m of ["replay", "forward"]) console.log(`paper ${m} (${res[m].rows} markets): ` + res[m].portfolios.map(p =>
    `${p.id} $${p.equity}${p.busted ? " BUST" : ""}${p.reachedGoal ? " GOAL" : ""} (${p.bets} bets${p.monteCarlo ? `, P($1000) ${(p.monteCarlo.pReachGoal * 100).toFixed(1)}%` : ""})`).join("; "));
}
