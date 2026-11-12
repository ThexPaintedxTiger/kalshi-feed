// The live engine: turns stream messages + a clock into market state, feature rows, re-estimates and settlements.
// Pure and deterministic: no network, no files, no Date.now(). The daemon feeds it real messages and real time; the replay
// test feeds it a recorded log and must get the same rows back.
//   onMessage(m, t)  one Kalshi WebSocket message received at time t (ms)
//   onClock(t)       call about once a second; returns { ticks, features, snaps, updates } produced since the last call
import { Market } from "./book.mjs";

export const LEADS = [60, 30, 15, 5];                        // minutes before resolution: training snapshots
const r4 = x => Math.round(x * 1e4) / 1e4;

export class Engine {
  // estimate(c) → { est, picks } for a snapshot c (same shape predictors.mjs takes); cfg = config.live.
  constructor({ estimate = null, cfg = {} } = {}) {
    this.estimate = estimate; this.cfg = { updateMove: 0.03, updateEveryMin: 15, updateMinGapSec: 60, staleSec: 90, ...cfg };
    this.markets = new Map(); this.meta = new Map(); this.settled = [];
    this.q = { ticks: [], features: [], snaps: [], updates: [] }; this.lastFine = 0; this.lastMinute = 0; this.changed = new Set(); this.live = false;
  }
  // Stream up/down. While it is up, a quiet market is not stale (books only send changes); while it is down, age decides.
  setLive(on) { this.live = !!on; if (!on) for (const mk of this.markets.values()) mk.synced = false; }
  fresh(mk, t) { return this.live ? mk.synced || t - mk.at <= this.cfg.staleSec * 1000 : t - mk.at <= this.cfg.staleSec * 1000; }
  // Watched markets: [{ ticker, event, series, cat, title, resolvesAt (ISO), logged: bool, mid0 (logged mid) }].
  setScope(list) {
    const keep = new Set(list.map(x => x.ticker));
    for (const x of list) { const old = this.meta.get(x.ticker); this.meta.set(x.ticker, { ...old, ...x, res: Date.parse(x.resolvesAt), leadsDone: old?.leadsDone || new Set(), lastUpd: old?.lastUpd || null }); if (!this.markets.has(x.ticker)) this.markets.set(x.ticker, new Market(x.ticker)); }
    for (const k of [...this.meta.keys()]) if (!keep.has(k)) { this.meta.delete(k); this.markets.delete(k); }
  }
  onMessage(m, t) {
    if (m.type === "_state") return this.setLive(m.live);
    if (m.type === "cfbenchmarks_value") {                                         // index value (e.g. BRTI): the crypto settlement reference
      const d = m.msg || {}; let v = null; try { v = +JSON.parse(d.data).value; } catch {}
      if (d.index_id && v > 0) (this.index ||= new Map()).set(d.index_id, { value: v, avg60: +d.avg_60s_data?.value || null, at: t });
      return;
    }                        // recorded stream up/down marker (replay)
    const d = m.msg || {}, k = d.market_ticker; if (!k) return;
    if (m.type === "market_lifecycle_v2") {
      const ev = d.event_type;
      if ((ev === "determined" || ev === "settled") && d.result) this.settled.push({ ticker: k, result: d.result, determinedAt: d.determination_ts ? d.determination_ts * 1000 : t, settledAt: d.settled_ts ? d.settled_ts * 1000 : null, value: d.settlement_value ?? null, at: t });
      else if (ev === "created" || ev === "activated") this.created = (this.created || 0) + 1;
      return;
    }
    const mk = this.markets.get(k); if (!mk) return;
    const before = mk.top();
    if (m.type === "orderbook_snapshot") mk.snapshot(d, t);
    else if (m.type === "orderbook_delta") mk.delta(d, t);
    else if (m.type === "trade") { mk.trade(d, t); if (!d.is_block_trade) this.q.ticks.push({ t, k, e: "t", p: mk.last.p, n: mk.last.n, s: mk.last.side }); }
    else if (m.type === "ticker") mk.ticker_(d, t);
    else return;
    const q = mk.top();
    if (q && (!before || before.bid !== q.bid || before.ask !== q.ask)) this.q.ticks.push({ t, k, e: "q", b: q.bid, a: q.ask, bs: q.bidSize, as: q.askSize });
    this.changed.add(k);
  }
  // REST fallback quotes (stream down): same path, marked as not synced.
  onRest(k, bid, ask, t) { const mk = this.markets.get(k); if (!mk) return; const b = mk.top(); mk.rest(bid, ask, t); if (!b || b.bid !== bid || b.ask !== ask) { this.q.ticks.push({ t, k, e: "q", b: bid, a: ask, r: 1 }); this.changed.add(k); } }
  snapshotRow(k, t, lead = null) {
    const mk = this.markets.get(k), me = this.meta.get(k), f = mk?.features(t); if (!f || !me) return null;
    return { ts: new Date(t).toISOString(), ticker: k, event: me.event, series: me.series, cat: me.cat, resolvesAt: me.resolvesAt, leadMin: lead ?? r4((me.res - t) / 6e4),
      bid: f.bid, ask: f.ask, mid: f.mid, spread: f.spread, micro: f.micro, microDiff: f.microDiff, imb5: f.imb5, flow1: f.flow1, flow5: f.flow5, flow30: f.flow30, vol30t: f.vol30t,
      vol1: f.vol1, vol5: f.vol5, vol30: f.vol30, chg30: f.chg30, synced: f.synced };
  }
  onClock(t) {
    const fine = t - this.lastFine >= 5000, minute = Math.floor(t / 6e4) !== this.lastMinute;
    if (fine) this.lastFine = t; if (minute) this.lastMinute = Math.floor(t / 6e4);
    for (const [k, mk] of this.markets) {
      const me = this.meta.get(k); if (!me) continue;
      if (fine) mk.sample(t, minute);
      const fresh = this.fresh(mk, t);
      if (minute && fresh && t < me.res) { const row = this.snapshotRow(k, t); if (row?.mid != null) this.q.features.push(row); }
      // Training snapshots at fixed leads, taken at (or just after) the moment, from data up to that moment only.
      for (const lead of LEADS) {
        const T = me.res - lead * 6e4;
        if (t >= T && t < T + 60e3 && !me.leadsDone.has(lead) && fresh) { me.leadsDone.add(lead); const row = this.snapshotRow(k, t, lead); if (row?.mid != null) this.q.snaps.push({ ...row, title: me.title, src: "minute" }); }
      }
      // Re-estimate a logged market when the price moved enough or enough time passed. The first logged row stays the scored one.
      if (this.estimate && me.logged && fresh && t < me.res && fine) {
        const mid = mk.mid(); if (mid == null) continue;
        const u = me.lastUpd || { t: me.loggedAt || t, mid: me.mid0 ?? mid };
        if (!me.lastUpd) me.lastUpd = u;
        const moved = r4(Math.abs(mid - u.mid)) >= this.cfg.updateMove, aged = t - u.t >= this.cfg.updateEveryMin * 6e4;
        if ((moved || aged) && t - u.t >= this.cfg.updateMinGapSec * 1000) {
          const f = mk.features(t), c = { mid, ask: f.ask, bid: f.bid, series: me.series, at: t, cat: me.cat, resolvesAt: me.resolvesAt, leadMin: (me.res - t) / 6e4, chg30: f.chg30, vol30: f.vol30, imb5: f.imb5, flow30: f.flow30,
            microDiff: f.microDiff, flow5: f.flow5, vol5: f.vol5, spread: f.spread, ext: me.ext };
          const { est, picks } = this.estimate(c);
          me.lastUpd = { t, mid }; me.est = est;
          this.q.updates.push({ ts: new Date(t).toISOString(), ticker: k, event: me.event, why: moved ? "move" : "time", leadMin: r4(c.leadMin), bid: f.bid, ask: f.ask, mid, from: u.mid, est, picks });
        }
      }
    }
    const out = this.q; this.q = { ticks: [], features: [], snaps: [], updates: [] };
    return out;
  }
  takeSettled() { const s = this.settled; this.settled = []; return s; }
  takeChanged() { const c = [...this.changed]; this.changed.clear(); return c; }
  // Compact view of one market for the live API / dashboard.
  view(k, t, depth = false) {
    const mk = this.markets.get(k), me = this.meta.get(k), f = mk?.features(t); if (!f || !me) return null;
    return { k, title: me.title, cat: me.cat, event: me.event, res: me.resolvesAt, logged: !!me.logged, b: f.bid, a: f.ask, mid: f.mid, last: f.last, micro: f.micro, imb: f.imb5, flow5: f.flow5, vol5: f.vol5,
      est: me.est || null, age: Math.round((t - mk.at) / 1000), synced: f.synced, ...(depth ? { depth: mk.depth(8) } : {}) };
  }
  staleness(t) { let n = 0, stale = 0, worst = 0; for (const [k, mk] of this.markets) { const me = this.meta.get(k); if (!me || t >= me.res) continue; n++; const age = (t - mk.at) / 1000; if (!this.fresh(mk, t)) { stale++; if (mk.at && age > worst) worst = age; } } return { markets: n, stale, worstSec: Math.round(worst), synced: [...this.markets.values()].filter(m => m.synced).length }; }
}
