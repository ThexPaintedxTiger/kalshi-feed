// Per-market live state built from Kalshi WebSocket messages: full order book, last trade, and rolling features.
// Pure (no I/O, no clock of its own): every method takes the time, so a recorded message log replays to the same numbers.
import { bookImbalance, takerSide, minuteStats } from "../nnlib.mjs";

const r4 = x => Math.round(x * 1e4) / 1e4;
export const px = v => { const x = +v; return r4(x > 1 ? x / 100 : x); };                    // cents or dollars → dollars
const levels = a => new Map((a || []).map(([p, q]) => [px(p), +q]).filter(([, q]) => q > 0));
const std = a => { if (a.length < 2) return null; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };

export class Market {
  constructor(ticker) {
    this.ticker = ticker; this.yes = new Map(); this.no = new Map(); this.synced = false;
    this.trades = [];            // { t (ms), side, n, p }  last 30 min
    this.fine = [];              // { t, mid } every 5 s, last 5 min   (short-horizon volatility)
    this.mins = [];              // { t (s), mid } every minute, last 35 min (same inputs as the candle-based features)
    this.last = null; this.tk = null; this.at = 0; this.msgs = 0;
  }
  snapshot(d, t) { this.yes = levels(d.yes_dollars_fp ?? d.yes_dollars ?? d.yes); this.no = levels(d.no_dollars_fp ?? d.no_dollars ?? d.no); this.synced = true; this.touch(t); }
  delta(d, t) {
    const side = this[d.side]; if (!side || !this.synced) return false;
    const p = px(d.price_dollars ?? d.price), q = Math.round(((side.get(p) || 0) + +(d.delta_fp ?? d.delta ?? 0)) * 100) / 100;
    if (q > 0) side.set(p, q); else side.delete(p);
    this.touch(t); return true;
  }
  trade(d, t) {
    if (d.is_block_trade) return;
    const tr = { t: d.ts_ms ?? (d.ts ? d.ts * 1000 : t), side: takerSide(d), n: +(d.count_fp ?? d.count) || 0, p: px(d.yes_price_dollars ?? d.yes_price) };
    this.trades.push(tr); this.last = tr; this.touch(t);
    while (this.trades.length && this.trades[0].t < t - 31 * 6e4) this.trades.shift();
  }
  ticker_(d, t) { this.tk = { bid: px(d.yes_bid_dollars ?? d.yes_bid ?? 0), ask: px(d.yes_ask_dollars ?? d.yes_ask ?? 0), price: px(d.price_dollars ?? d.price ?? 0), vol: +(d.volume_fp ?? d.volume ?? 0), oi: +(d.open_interest_fp ?? d.open_interest ?? 0) }; this.touch(t); }
  // Quotes from REST (fallback when the stream is down): keeps prices moving, marks the book as not synced.
  rest(bid, ask, t) { this.tk = { ...(this.tk || {}), bid, ask }; this.synced = false; this.touch(t); }
  touch(t) { this.at = t; this.msgs++; }
  // Best YES bid, and best YES ask = 1 − best NO bid. Falls back to the ticker channel / REST when the book isn't synced.
  top() {
    if (this.synced) {
      let yb = 0, nb = 0; for (const p of this.yes.keys()) if (p > yb) yb = p; for (const p of this.no.keys()) if (p > nb) nb = p;
      if (yb > 0 || nb > 0) return { bid: yb, ask: nb > 0 ? r4(1 - nb) : 1, bidSize: this.yes.get(yb) || 0, askSize: this.no.get(nb) || 0 };
    }
    return this.tk ? { bid: this.tk.bid, ask: this.tk.ask || 1, bidSize: 0, askSize: 0 } : null;
  }
  mid() { const q = this.top(); return q && q.bid > 0 && q.ask < 1 && q.ask > q.bid ? r4((q.bid + q.ask) / 2) : null; }
  // Called by the engine's clock: every 5 s, and once a minute.
  sample(t, minute) {
    const mid = this.mid(); if (mid == null) return;
    this.fine.push({ t, mid }); while (this.fine.length && this.fine[0].t < t - 5 * 6e4 - 1) this.fine.shift();
    if (minute) { this.mins.push({ t: Math.floor(t / 1000), mid }); while (this.mins.length && this.mins[0].t < t / 1000 - 35 * 60) this.mins.shift(); }
  }
  depth(n = 5) {
    const side = m => [...m].sort((a, b) => b[0] - a[0]).slice(0, n);
    return { yes: side(this.yes), no: side(this.no) };
  }
  // Features as of time t, from what has been received up to t only.
  features(t) {
    const q = this.top(); if (!q) return null;
    const two = q.bid > 0 && q.ask < 1 && q.ask > q.bid, mid = two ? r4((q.bid + q.ask) / 2) : null;
    // Microprice: the side with more resting size pulls the fair price toward the other side's quote.
    const micro = two && q.bidSize + q.askSize > 0 ? r4((q.bid * q.askSize + q.ask * q.bidSize) / (q.bidSize + q.askSize)) : mid;
    const flow = w => { let y = 0, n = 0; for (const x of this.trades) if (x.t > t - w * 6e4 && x.t <= t) { if (x.side === "yes") y += x.n; else if (x.side === "no") n += x.n; } return { f: y + n > 0 ? r4((y - n) / (y + n)) : null, v: Math.round((y + n) * 100) / 100 }; };
    const volFine = w => { const p = this.fine.filter(x => x.t > t - w * 6e4 && x.t <= t); const s = std(p.slice(1).map((x, i) => x.mid - p[i].mid)); return s == null || p.length < 6 ? null : r4(s * Math.sqrt(12)); };   // per-minute units
    const ms = minuteStats(this.mins, Math.floor(t / 1000)), f1 = flow(1), f5 = flow(5), f30 = flow(30);
    return { bid: q.bid, ask: q.ask, mid, spread: two ? r4(q.ask - q.bid) : null, bidSize: q.bidSize, askSize: q.askSize, micro, microDiff: mid == null || micro == null ? null : r4(micro - mid),
      imb5: this.synced ? bookImbalance([...this.yes], [...this.no]) : null, flow1: f1.f, flow5: f5.f, flow30: f30.f, vol30t: f30.v,
      vol1: volFine(1), vol5: volFine(5), vol30: ms.vol30, chg30: ms.chg30, last: this.last ? this.last.p : this.tk?.price || null, synced: this.synced, at: this.at };
  }
}
