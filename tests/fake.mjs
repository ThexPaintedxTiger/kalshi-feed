// Test doubles: a fake WebSocket (the test plays the server) and a fake clock with timers.
export class FakeSocket {
  constructor() { this.sent = []; this.closed = false; FakeSocket.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { if (this.closed) return; this.closed = true; this.onclose?.({ code: 1000 }); }
  open() { this.onopen?.(); }
  recv(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop(code = 1006) { this.closed = true; this.onclose?.({ code }); }                 // server-side disconnect
  cmds(cmd) { return this.sent.filter(x => x.cmd === cmd); }
  // Play Kalshi's side of a subscribe: one `subscribed` per channel with a fresh sid.
  ack() { let n = 0; for (const c of this.cmds("subscribe")) for (const ch of c.params.channels) { if (this.acked?.has(ch)) continue; (this.acked ||= new Map()).set(ch, FakeSocket.sid); this.recv({ id: c.id, type: "subscribed", msg: { channel: ch, sid: FakeSocket.sid++ } }); n++; } return n; }
  sid(ch) { return this.acked.get(ch); }
}
FakeSocket.all = []; FakeSocket.sid = 1;
export function fakeClock(start = Date.parse("2026-11-12T12:00:00Z")) {
  let t = start, id = 0; const timers = new Map();
  return { now: () => t, set: (fn, ms) => { timers.set(++id, { at: t + ms, fn }); return id; }, clear: i => timers.delete(i),
    advance(ms) { const end = t + ms; for (;;) { const next = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; timers.delete(next[0]); t = next[1].at; next[1].fn(); } t = end; }, pending: () => timers.size };
}
