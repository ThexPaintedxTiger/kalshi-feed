// Maker paper portfolio: what if, instead of paying the spread, we rested limit orders and waited to be hit?
// For every logged prediction (once it has resolved) it "posts" one contract on each side at the prices quoted when the
// prediction was logged: a YES bid at the best bid, and a NO bid at 1 − best ask. An order fills ONLY if a real later trade
// crosses it (from Kalshi's public trade tape, between the prediction and resolution):
//   - a trade strictly through our price fills us; or
//   - trades AT our price fill us only after the size that was already resting there (the queue ahead of us) has traded.
// Filled contracts are held to settlement. Fee: Kalshi's maker fee, ceil(0.0175 × P × (1−P)) per contract (charged as if it
// always applies — conservative). This measures spread capture against adverse selection (being filled mostly when wrong).
// SIMULATION ONLY. Rows are append-only in data/maker/YYYY-MM.jsonl.
import { kalshi, sleep, r4, readJsonl, appendJsonl, allMonthFiles } from "./lib.mjs";
import { takerSide } from "./nnlib.mjs";

export const makerFee = p => Math.ceil(0.0175 * p * (1 - p) * 100 - 1e-9) / 100;
// trades: [{ t (ms), yes (YES price), n, side ("yes" = taker bought YES, "no" = taker bought NO) }], any order.
export function simulate(pred, trades, y) {
  const t0 = Date.parse(pred.loggedAt || pred.ts), t1 = Date.parse(pred.resolvesAt), tr = trades.filter(x => x.t > t0 && x.t < t1).sort((a, b) => a.t - b.t);
  const side = (px, queue, hits) => { let ahead = queue || 0; for (const x of tr) { const p = hits(x); if (p == null) continue; if (p < px - 1e-9) return x.t; if (Math.abs(p - px) < 1e-9) { ahead -= x.n; if (ahead < 0) return x.t; } } return null; };
  // Our YES bid is hit by takers SELLING YES (= buying NO) at yes price ≤ bid. Our NO bid (at 1 − ask) is hit by takers buying YES at yes price ≥ ask.
  const yesAt = side(pred.bid, pred.bidSize, x => (x.side === "no" ? x.yes : null)), noPx = r4(1 - pred.ask), noAt = side(noPx, pred.askSize, x => (x.side === "yes" ? r4(1 - x.yes) : null));
  const leg = (px, at, win) => (at == null ? { px, filled: false } : { px, filled: true, at: new Date(at).toISOString(), pnl: r4((win ? 1 : 0) - px - makerFee(px)) });
  const Y = leg(pred.bid, yesAt, y === 1), N = leg(noPx, noAt, y === 0);
  return { ts: pred.ts, ticker: pred.ticker, event: pred.event, cat: pred.cat, y, trades: tr.length, yes: Y, no: N, pnl: r4((Y.pnl || 0) + (N.pnl || 0)) };
}
const rows = () => allMonthFiles("maker").flatMap(f => readJsonl(f));

export function summary(all, start = 10) {
  const legs = all.flatMap(r => [r.yes, r.no]), filled = legs.filter(l => l.filled), pnl = filled.reduce((s, l) => s + l.pnl, 0);
  const both = all.filter(r => r.yes.filled && r.no.filled).length, wins = filled.filter(l => l.pnl > 0).length;
  return { start, equity: r4(start + pnl), orders: legs.length, fills: filled.length, fillRate: legs.length ? r4(filled.length / legs.length) : null, settled: filled.length, wins, pnl: r4(pnl), perFill: filled.length ? r4(pnl / filled.length) : null,
    roundTrips: both, markets: all.length, note: "One contract per side at the quoted best bid/offer; filled only when a later real trade crosses (queue ahead respected); held to settlement; maker fee always charged. Winning less than half of fills at a small spread = adverse selection." };
}

export async function run(ctx, { max = 40, fetchTrades = null } = {}) {
  const done = new Set(rows().map(r => r.ticker)), s = ctx.store, todo = s.preds.filter(p => p.cfg >= 9 && !p.shadow && !done.has(p.ticker) && s.result(p.ticker) != null && p.bid > 0 && p.ask < 1).slice(-max), out = [];
  for (const p of todo) {
    try {
      const a = Math.floor(Date.parse(p.ts) / 1000), b = Math.ceil(Date.parse(p.resolvesAt) / 1000);
      const raw = fetchTrades ? await fetchTrades(p) : ((await kalshi(`/markets/trades?ticker=${encodeURIComponent(p.ticker)}&min_ts=${a}&max_ts=${b}&limit=1000`)).trades || []);
      const trades = raw.filter(x => !x.is_block_trade).map(x => ({ t: Date.parse(x.created_time), yes: +x.yes_price_dollars, n: +x.count_fp || 0, side: takerSide(x) }));
      out.push(simulate(p, trades, s.result(p.ticker)));
    } catch (e) { ctx.log(`maker: ${p.ticker}: ${e.message}`); }
    if (!fetchTrades) await sleep(120);
  }
  for (const [ym, rs] of Object.entries(out.reduce((g, r) => ((g[r.ts.slice(0, 7)] ||= []).push(r), g), {}))) appendJsonl(`data/maker/${ym}.jsonl`, rs);
  const sm = ctx.emit("maker", summary(rows()));
  return `maker: +${out.length} markets simulated; ${sm.fills}/${sm.orders} orders filled, P&L ${sm.pnl} (${sm.perFill} per fill)`;
}
if (import.meta.url === `file://${process.argv[1]}`) { const { makeCtx } = await import("./core/ctx.mjs"); console.log(await run(makeCtx(), { max: +process.argv[2] || 40 })); }
