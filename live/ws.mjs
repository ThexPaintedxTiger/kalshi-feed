// Kalshi market-data WebSocket client: subscribes, keeps the watched set in sync, checks sequence numbers, and reconnects.
// Read-only: the only commands it can send are subscribe / update_subscription / unsubscribe on market-data channels
// (kalshi-auth.mjs → assertChannels throws on anything else, before a message is built).
// The socket is injected (`connect()`), so tests and the replay harness drive it with a fake socket and a fake clock.
import { EventEmitter } from "node:events";
import { assertChannels } from "../kalshi-auth.mjs";

const PER_MARKET = ["orderbook_delta", "trade", "ticker"], CHUNK = 100;

export class KalshiWS extends EventEmitter {
  constructor({ connect, lifecycle = true, indices = [], now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, quietMs = 30e3, log = () => {} }) {
    super(); Object.assign(this, { connect, lifecycle, indices, now, setTimer, clearTimer, quietMs, log });
    this.want = new Set(); this.have = new Set(); this.sids = {}; this.seq = {}; this.pending = new Map(); this.id = 0;
    this.state = "idle"; this.backoff = 1000; this.stats = { messages: 0, reconnects: 0, gaps: 0, errors: 0, lastMsgAt: 0, connectedAt: 0, downMs: 0, downSince: now() };
    this.stopped = false; this.sock = null;
  }
  start() { this.stopped = false; this.open(); }
  stop() { this.stopped = true; this.clearTimer(this.retry); this.clearTimer(this.quiet); try { this.sock?.close(); } catch {} this.setState("stopped"); }
  setState(s) { if (s !== this.state) { const t = this.now(); if (s === "live") { this.stats.downMs += t - (this.stats.downSince ?? t); this.stats.downSince = null; } else if (this.state === "live") this.stats.downSince = t; this.state = s; this.emit("state", s); } }
  open() {
    if (this.stopped) return;
    this.setState("connecting"); this.have = new Set(); this.sids = {}; this.seq = {}; this.pending.clear(); this.subSent = false; this.stats.connectedAt = 0;
    let s; try { s = this.sock = this.connect(); } catch (e) { this.log(`stream connect failed: ${e.message}`); return this.schedule(); }
    s.onopen = () => { if (s !== this.sock) return; this.stats.connectedAt = this.now(); this.subscribeAll(); this.arm(); };
    s.onmessage = e => { if (s !== this.sock) return; let m; try { m = JSON.parse(typeof e === "string" ? e : e.data); } catch { return; } this.onMessage(m); };
    s.onclose = e => { if (s !== this.sock) return; this.sock = null; this.log(`stream closed (${e?.code ?? "?"})`); this.schedule(); };
    s.onerror = () => { this.stats.errors++; };
  }
  schedule() {
    if (this.stopped) return;
    this.setState("reconnecting"); this.stats.reconnects++; this.clearTimer(this.quiet);
    const wait = Math.min(60e3, this.backoff); this.backoff = Math.min(60e3, this.backoff * 2);
    this.retry = this.setTimer(() => this.open(), wait);
  }
  // No message at all for quietMs (Kalshi's ticker channel alone is busier than that) → treat the socket as dead.
  arm() { this.clearTimer(this.quiet); this.quiet = this.setTimer(() => { this.log("stream silent — reconnecting"); try { this.sock?.close(); } catch {} if (this.sock) { this.sock = null; this.schedule(); } }, this.quietMs); }
  send(cmd, params) { const id = ++this.id; this.pending.set(id, { cmd, params }); this.sock?.send(JSON.stringify({ id, cmd, params })); return id; }
  subscribeAll() {
    this.subSent = false;
    if (this.lifecycle) this.send("subscribe", { channels: assertChannels(["market_lifecycle_v2"]) });
    if (this.indices.length) this.send("subscribe", { channels: assertChannels(["cfbenchmarks_value"]), index_ids: this.indices });   // settlement reference values
    this.first();
  }
  // First per-market subscribe (creates the three subscriptions); the rest of the set is added once their sids are known.
  first() {
    if (this.subSent || !this.want.size || !this.sock) return;
    const chunk = [...this.want].slice(0, CHUNK); this.subSent = true;
    this.send("subscribe", { channels: assertChannels(PER_MARKET), market_tickers: chunk }); for (const t of chunk) this.have.add(t);
  }
  // The watched set changed: add/remove markets on the existing subscriptions (no reconnect).
  setMarkets(tickers) {
    this.want = new Set(tickers);
    if (!this.sock || !this.stats.connectedAt || this.state === "reconnecting") return;
    if (!this.subSent) return this.first();
    if (!this.perMarketReady()) return;                                         // diff is applied when the sids arrive
    const add = [...this.want].filter(t => !this.have.has(t)), del = [...this.have].filter(t => !this.want.has(t));
    this.update("add_markets", add); this.update("delete_markets", del);
    for (const t of add) this.have.add(t); for (const t of del) this.have.delete(t);
  }
  perMarketReady() { return PER_MARKET.every(c => this.sids[c] != null); }
  update(action, tickers) {
    for (let i = 0; i < tickers.length; i += CHUNK) for (const c of PER_MARKET) this.send("update_subscription", { sids: [this.sids[c]], market_tickers: tickers.slice(i, i + CHUNK), action });
  }
  // Missed a message on the order-book subscription: ask for fresh snapshots of every market on it.
  resync(reason) {
    this.stats.gaps++; this.emit("gap", reason);
    const all = [...this.have], sid = this.sids.orderbook_delta; if (sid == null) return;
    for (let i = 0; i < all.length; i += CHUNK) this.send("update_subscription", { sids: [sid], market_tickers: all.slice(i, i + CHUNK), action: "get_snapshot" });
  }
  onMessage(m) {
    this.stats.messages++; this.stats.lastMsgAt = this.now(); this.arm();
    if (m.type === "subscribed") {
      this.sids[m.msg.channel] = m.msg.sid; this.seq[m.msg.sid] = null; this.backoff = 1000;
      this.setState("live"); if (this.perMarketReady()) this.setMarkets([...this.want]);
      return;
    }
    if (m.type === "error") { this.stats.errors++; const p = this.pending.get(m.id); this.pending.delete(m.id); this.log(`stream error ${m.msg?.code}: ${m.msg?.msg}${p ? ` (${p.cmd})` : ""}`); this.emit("server_error", m); return; }
    if (m.type === "ok" || m.type === "unsubscribed") { this.pending.delete(m.id); return; }
    // Sequence check per subscription: seq must rise by exactly 1.
    if (m.sid != null && m.seq != null) {
      const last = this.seq[m.sid];
      if (last != null && m.seq !== last + 1) { this.seq[m.sid] = m.seq; if (m.sid === this.sids.orderbook_delta && m.type !== "orderbook_snapshot") this.resync(`seq ${last} → ${m.seq}`); }
      else this.seq[m.sid] = m.seq;
    }
    this.emit("message", m);
  }
  health() { const t = this.now(), s = this.stats; return { state: this.state, messages: s.messages, reconnects: s.reconnects, gaps: s.gaps, errors: s.errors, markets: this.have.size, lastMsgAgeMs: s.lastMsgAt ? t - s.lastMsgAt : null, downMs: s.downMs + (s.downSince != null ? t - s.downSince : 0) }; }
}
