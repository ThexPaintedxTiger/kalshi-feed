// Paper trading: several $10 portfolios, each with its own strategy, trade the agent's predictions with realistic costs
// (buy YES at the ask or NO at 1 − bid, Kalshi taker fee per order rounded up to the cent, cash locked until settlement).
// Goal: grow $10 toward $1,000 OVER TIME without ever risking the account on one bet.
// Safety rules for every strategy (config.json → paper.safety):
//   - at most 5% of the bankroll on any one bet, at most 25% of the bankroll in open bets at once;
//   - after a 20% drop from the peak, bets are halved; after a 40% drop, quartered.
// Learned bet size ("learn" strategies): start with 1% probe bets; once 30+ bets have settled, size up toward quarter-Kelly
// only in proportion to how much of the predicted edge the strategy has actually delivered (conservatively measured).
// Modes: replay (past settled markets; the network only trades markets it never trained on) and forward (live predictions).
// SIMULATION ONLY. Nothing is traded. Rebuilt from the logs each run → data/paper/portfolios.json.
import { config, r4, hash, mean } from "./lib.mjs";
import { rng } from "./nnlib.mjs";

const P = config.paper, SAFE = P.safety, LEARN = P.learning, excluded = new Set(config.scan.excludeCategories || []);
export const orderFee = (price, contracts) => Math.ceil(0.07 * contracts * price * (1 - price) * 100 - 1e-9) / 100;
// Kelly fraction for a binary contract bought at price c with win probability q, after the per-contract fee.
export const kellyFraction = (q, c, feePer = 0) => Math.max(0, (q - c - feePer) / (1 - c));

// How much to trust a strategy's predicted edge, from its own settled bets so far (only the past: no look-ahead).
// trust = (realized return per $ − 1 standard error) ÷ predicted return per $, clipped to 0…1.
export function trustFrom(done) {
  if (done.length < LEARN.minTrack) return { trust: 0, why: `learning: ${done.length}/${LEARN.minTrack} settled bets` };
  const r = done.map(b => b.pnl / b.stake), m = mean(r), sd = Math.sqrt(mean(r.map(x => (x - m) ** 2)) * r.length / (r.length - 1));
  const lower = m - sd / Math.sqrt(r.length), pred = Math.max(1e-3, mean(done.map(b => b.evPerDollar)));
  if (m + sd / Math.sqrt(r.length) < 0) return { trust: 0, pause: true, why: `losing even on the optimistic estimate (${r4(m + sd / Math.sqrt(r.length))} per $): paused, tracking shadow bets` };
  if (lower <= 0) return { trust: 0, why: `edge not proven yet (return per $ ${r4(m)}, conservative ${r4(lower)})` };
  return { trust: r4(Math.min(1, lower / pred)), why: `delivered ${r4(lower)} per $ vs predicted ${r4(pred)}` };
}

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
  return { side, c, q, evPerDollar: (q - c - orderFee(c, 1)) / c };
}

export function simulate(pf, rows) {
  let cash = P.start, open = [], peak = P.start, maxDD = 0, low = P.start, reachedAt = null, busted = null;
  const bets = [], curve = [[rows[0] ? Date.parse(rows[0].ts) : Date.now(), P.start]];
  const exposure = () => open.filter(o => !o.shadow).reduce((s, o) => s + o.C * o.c, 0), equity = () => cash + exposure();
  const settle = until => {
    open.sort((a, b) => a.settle - b.settle);
    while (open.length && open[0].settle <= until) {
      const o = open.shift(), payout = o.win ? o.C : 0;
      o.bet.pnl = r4(payout - o.C * o.c - o.fee); o.bet.won = o.win; o.bet.settledAt = new Date(o.settle).toISOString();
      if (o.shadow) continue;                                                    // shadow bets move no money
      cash += payout;
      const e = equity(); curve.push([o.settle, r4(e)]);
      peak = Math.max(peak, e); maxDD = Math.max(maxDD, (peak - e) / peak); low = Math.min(low, e);
      if (!reachedAt && e >= P.goal) reachedAt = new Date(o.settle).toISOString();
    }
  };
  const sizeFor = (d, bank) => {
    let frac, t = null;
    if (pf.sizing === "learn") {
      t = trustFrom(bets.filter(b => b.pnl != null));
      frac = Math.max(LEARN.probe, (LEARN.probeMinDollars || 0) / bank, t.trust * LEARN.kelly * kellyFraction(d.q, d.c, orderFee(d.c, 1)));
    } else if (pf.sizing === "kelly") frac = (pf.kelly ?? 0.25) * kellyFraction(d.q, d.c, orderFee(d.c, 1));
    else frac = pf.frac ?? 0.02;
    const dd = 1 - bank / peak;
    for (const [level, mult] of SAFE.brakes) if (dd >= level) frac = Math.min(frac, frac * mult);  // losing streak brake
    return { frac: Math.min(frac, SAFE.maxFracPerBet), trust: t, pause: !!t?.pause };
  };
  let lastTrust = null;
  for (const row of rows) {
    const t = Date.parse(row.ts); settle(t);
    if (busted) break;
    if (equity() < P.bustBelow && !open.length) { busted = new Date(t).toISOString(); break; }
    const d = decide(pf, row); if (!d) continue;
    const bank = equity(), { frac, trust, pause } = sizeFor(d, bank); lastTrust = trust;
    if (pause) {                                                                 // proven loser: record what it WOULD do, at probe size, no money
      const C = r4((LEARN.probeMinDollars || 0.25) / d.c), win = row.y == null ? null : (d.side === "yes" ? row.y === 1 : row.y === 0);
      const bet = { ts: row.ts, ticker: row.ticker, title: row.title, cat: row.cat, side: d.side, price: d.c, p: r4(d.q != null && d.side === "no" ? 1 - d.q : d.q), mid: row.mid, contracts: C, fee: orderFee(d.c, C), shadow: true,
        stake: r4(C * d.c + orderFee(d.c, C)), bankroll: r4(bank), betPct: 0, evPerDollar: r4(d.evPerDollar), pnl: null, won: null };
      bets.push(bet); open.push({ settle: win == null ? Infinity : Date.parse(row.settledAt || row.resolvesAt), win, C, c: d.c, fee: bet.fee, bet, shadow: true });
      continue;
    }
    const room = SAFE.maxOpenExposure * bank - exposure();                       // cap on money tied up in open bets
    const budget = Math.min(frac * bank, room, cash);                           // the cap includes the fee
    let C = Math.min(budget / d.c, P.maxContracts, P.maxDollarsPerBet / d.c);
    while (C > 0 && C * d.c + orderFee(d.c, C) > budget) C *= 0.97;
    C = Math.floor(C * 100) / 100;
    if (C * d.c < 0.1) continue;                                                 // too small to place
    const fee = orderFee(d.c, C); cash -= C * d.c + fee;
    const win = row.y == null ? null : (d.side === "yes" ? row.y === 1 : row.y === 0);
    const bet = { ts: row.ts, ticker: row.ticker, title: row.title, cat: row.cat, side: d.side, price: d.c, p: r4(d.q != null && d.side === "no" ? 1 - d.q : d.q), mid: row.mid, contracts: C, fee,
      stake: r4(C * d.c + fee), bankroll: r4(bank), betPct: r4((C * d.c + fee) / bank * 100), evPerDollar: r4(d.evPerDollar), pnl: null, won: null };
    bets.push(bet);
    open.push({ settle: win == null ? Infinity : Date.parse(row.settledAt || row.resolvesAt), win, C, c: d.c, fee, bet });
  }
  settle(Date.now());
  const real = bets.filter(b => !b.shadow), done = real.filter(b => b.pnl != null);
  const span = rows.length > 1 ? (Date.parse(rows.at(-1).ts) - Date.parse(rows[0].ts)) / 864e5 : 0;
  return { id: pf.id, name: pf.name, predictor: pf.predictor, sizing: pf.sizing || null, equity: r4(equity()), cash: r4(cash), openPositions: open.length,
    returnPct: r4((equity() / P.start - 1) * 100), bets: real.length, shadowBets: bets.length - real.length, settled: done.length, wins: done.filter(b => b.won).length,
    pnl: r4(done.reduce((s, b) => s + b.pnl, 0)), fees: r4(real.reduce((s, b) => s + b.fee, 0)), maxDrawdownPct: r4(maxDD * 100), lowest: r4(low),
    avgBetPct: r4(mean(real.map(b => b.betPct))), maxBetPct: r4(Math.max(0, ...real.map(b => b.betPct))),
    worstLossPct: r4(Math.min(0, ...done.map(b => b.pnl / b.bankroll * 100))),
    betsPerDay: span > 0 ? r4(real.length / span) : null, trustNow: pf.sizing === "learn" ? trustFrom(bets.filter(b => b.pnl != null)) : null,
    busted, reachedGoal: reachedAt, returns: done.map(b => b.pnl / b.bankroll), curve: thin(curve, 200), recent: bets.slice(-15).reverse(),
    stats: tradeStats(done, curve), review: pf.predictor && pf.predictor !== "coin" ? disagreementReview(done) : null, closed: done.slice().sort((a, b) => b.settledAt.localeCompare(a.settledAt)).slice(0, 10) };
}
// Loss review: on each settled bet the strategy disagreed with the market price. Who was closer to the real outcome?
// If the predictor is learning from its misses, the share where it was closer should rise over time (first half vs second half).
export function disagreementReview(done) {
  const rows = done.filter(b => b.p != null && b.mid != null && b.won != null).map(b => {
    const y = b.side === "yes" ? (b.won ? 1 : 0) : (b.won ? 0 : 1);
    return { closer: Math.abs(b.p - y) < Math.abs(b.mid - y), lost: b.pnl < 0 };
  });
  const share = a => a.length ? r4(a.filter(r => r.closer).length / a.length) : null, h = Math.floor(rows.length / 2);
  return { n: rows.length, netCloser: share(rows), losses: rows.filter(r => r.lost).length,
    firstHalf: share(rows.slice(0, h)), secondHalf: share(rows.slice(h)) };
}

// Trading statistics for the dashboard's Trading tab (settled paper bets only).
export function tradeStats(done, curve = []) {
  const p = done.map(b => b.pnl), wins = p.filter(x => x > 0), losses = p.filter(x => x < 0);
  const gp = wins.reduce((s, x) => s + x, 0), gl = -losses.reduce((s, x) => s + x, 0), net = gp - gl;
  const daily = {};
  for (const b of done) { const d = (b.settledAt || b.ts).slice(0, 10); daily[d] = r4((daily[d] || 0) + b.pnl); }
  const days = Object.entries(daily).sort((a, b) => a[0].localeCompare(b[0])).map(([date, pnl]) => ({ date, pnl }));
  let peak = -Infinity, maxDDd = 0; const dd = [];
  for (const [t, e] of curve) { peak = Math.max(peak, e); maxDDd = Math.max(maxDDd, peak - e); dd.push([t, r4(peak > 0 ? -(peak - e) / peak * 100 : 0)]); }
  const r = done.map(b => b.pnl / b.bankroll), m = mean(r), sd = Math.sqrt(mean(r.map(x => (x - m) ** 2)));
  let streak = 0, kind = null;
  for (const b of done.slice().sort((a, b) => (b.settledAt || "").localeCompare(a.settledAt || ""))) { const k = b.pnl > 0 ? "win" : "loss"; if (kind && k !== kind) break; kind = k; streak++; }
  return { trades: done.length, wins: wins.length, losses: losses.length, winRate: done.length ? r4(wins.length / done.length) : null,
    grossProfit: r4(gp), grossLoss: r4(gl), net: r4(net), profitFactor: gl > 0 ? r4(gp / gl) : null,
    best: p.length ? r4(Math.max(...p)) : null, worst: p.length ? r4(Math.min(...p)) : null, expectedPayoff: p.length ? r4(net / p.length) : null,
    recoveryFactor: maxDDd > 0 ? r4(net / maxDDd) : null, perBetSharpe: sd > 0 ? r4(m / sd) : null,
    avgDailyPnl: days.length ? r4(net / days.length) : null, lastDay: days.at(-1) || null, streak: kind ? { kind, n: streak } : null,
    daily: days.slice(-30), drawdown: thin(dd, 200) };
}
const thin = (a, n) => a.length <= n ? a : a.filter((_, i) => i % Math.ceil(a.length / n) === 0 || i === a.length - 1);

// Bootstrap: draw this strategy's past per-bet results at random to build many possible futures.
// Reports the chance of reaching $1,000 within N bets, the chance of ever falling below the low-water mark, and the pace.
export function monteCarlo(returns, o = P.monteCarlo, betsPerDay = null) {
  if (returns.length < 20) return null;
  // Conservative: shift every past result down by the uncertainty of their average (1 standard error), so a lucky
  // streak can't pass for an edge. A strategy has to have earned a real, measurable edge to show a path to $1,000.
  const m0 = mean(returns), se = Math.sqrt(mean(returns.map(x => (x - m0) ** 2)) / (returns.length - 1));
  returns = returns.map(x => x - se);
  const rand = rng(o.seed), horizons = o.horizons || [o.maxBets], H = Math.max(...horizons);
  const hitAt = [], lowHit = [], finals = Object.fromEntries(horizons.map(h => [h, []]));
  for (let p = 0; p < o.paths; p++) {
    let e = P.start, hit = null, low = false;
    for (let k = 1; k <= H; k++) {
      e *= 1 + returns[Math.floor(rand() * returns.length)];
      if (e < SAFE.lowWater) low = true;
      if (!hit && e >= P.goal) hit = k;
      if (finals[k]) finals[k].push(e);
      if (e < P.bustBelow) { for (const h of horizons) if (h > k) finals[h].push(e); break; }
    }
    hitAt.push(hit); lowHit.push(low);
  }
  const g = mean(returns.map(r => Math.log(Math.max(1e-9, 1 + r))));
  const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  const betsFor100x = g > 0 ? Math.ceil(Math.log(P.goal / P.start) / g) : null;
  return { paths: o.paths, conservativeShift: r4(se), observedMeanReturn: r4(m0), growthPerBet: r4(g), betsFor100x, daysFor100x: betsFor100x && betsPerDay ? Math.ceil(betsFor100x / betsPerDay) : null,
    pBelowLowWater: r4(mean(lowHit.map(Number))),
    byHorizon: horizons.map(h => ({ bets: h, pReachGoal: r4(mean(hitAt.map(x => (x && x <= h ? 1 : 0)))), medianEquity: r4(med(finals[h])) })) };
}

export function run(ctx) {
  const oos = ctx.get("nn-oos", "state") || {}, out = Object.fromEntries(ctx.store.out);
  const replay = ctx.store.backtest.filter(r => !excluded.has(r.cat)).map(r => ({ ...r, est: { ...r.est, nn: oos[r.ticker] } }))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const forward = ctx.store.preds.filter(p => p.cfg >= 4 && !p.shadow && !excluded.has(p.cat)).map(p => {
    const o = out[p.ticker], y = o?.result === "yes" ? 1 : o?.result === "no" ? 0 : null;
    return { ...p, y, settledAt: o?.settledAt || p.resolvesAt };
  }).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const run = rows => P.portfolios.map(pf => { const s = simulate(pf, rows); const mc = monteCarlo(s.returns, P.monteCarlo, s.betsPerDay); delete s.returns; return { ...s, monteCarlo: mc }; });
  const res = {
    updated: new Date().toISOString(), start: P.start, goal: P.goal, safety: SAFE, learning: LEARN,
    note: "SIMULATION ONLY — paper money, nothing is traded. Replay = past settled markets (supporting evidence; the neural net uses out-of-sample predictions only). Forward = live predictions (the record that counts). Fills assume the quoted price; real fills on thin markets can be worse.",
    replay: { rows: replay.length, from: replay[0]?.ts || null, to: replay.at(-1)?.ts || null, portfolios: run(replay) },
    forward: { rows: forward.length, settled: forward.filter(r => r.y != null).length, portfolios: run(forward) },
  };
  ctx.emit("paper", res);
  return ["replay", "forward"].map(m => `paper ${m} (${res[m].rows} markets): ` + res[m].portfolios.map(p =>
    `${p.id} $${p.equity} (${p.bets} bets, max bet ${p.maxBetPct}%, worst loss ${p.worstLossPct}%${p.busted ? ", BUST" : ""}${p.monteCarlo ? `, P($1000 in ${p.monteCarlo.byHorizon.at(-1).bets} bets) ${(p.monteCarlo.byHorizon.at(-1).pReachGoal * 100).toFixed(1)}%` : ""})`).join("; ")).join("\n");
}
if (import.meta.url === `file://${process.argv[1]}`) { const { makeCtx } = await import("./core/ctx.mjs"); console.log(run(makeCtx())); }
