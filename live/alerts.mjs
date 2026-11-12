// Alerts to the owner's phone. The webhook address is a secret: it lives only in private/alerts.json on the owner's computer
//   { "ntfy": "https://ntfy.sh/<your-topic>" }   or   { "discord": "https://discord.com/api/webhooks/..." }
// Without that file alerts are still recorded (data/alerts.jsonl, shown on the dashboard), just not sent anywhere.
// Each alert has a key; the same key is not sent again within its cooldown.
// CLI (used by start.sh when the daemon exits):  node live/alerts.mjs "title" "message"
import { readJson, writeJson, appendJsonl } from "../lib.mjs";

const STATE = "state/alerts.json";
export function target(file = "private/alerts.json") { const c = readJson(file, null); return c?.ntfy ? { kind: "ntfy", url: c.ntfy } : c?.discord ? { kind: "discord", url: c.discord } : null; }

export async function send(t, title, body, priority = "default", fetchFn = fetch) {
  if (!t) return false;
  try {
    const r = t.kind === "ntfy" ? await fetchFn(t.url, { method: "POST", headers: { Title: title.replace(/[^\x20-\x7e]/g, ""), Priority: priority, Tags: "chart_with_upwards_trend" }, body })
      : await fetchFn(t.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) }) });
    return r.ok;
  } catch { return false; }
}

export class Alerts {
  constructor({ now = Date.now, tgt = target(), fetchFn = fetch, persist = true } = {}) { Object.assign(this, { now, tgt, fetchFn, persist }); this.last = persist ? readJson(STATE, {}) : {}; this.recent = []; }
  // Returns true when the alert was raised (not suppressed by its cooldown).
  async raise(key, title, body, { cooldownMin = 60, priority = "default" } = {}) {
    const t = this.now(); if (this.last[key] && t - this.last[key] < cooldownMin * 6e4) return false;
    this.last[key] = t;
    const sent = await send(this.tgt, title, body, priority, this.fetchFn), row = { ts: new Date(t).toISOString(), key, title, body, sent };
    this.recent.push(row); if (this.recent.length > 30) this.recent.shift();
    if (this.persist) { writeJson(STATE, this.last); appendJsonl("data/alerts.jsonl", [row]); }
    return true;
  }
  clear(key) { if (this.last[key]) { delete this.last[key]; if (this.persist) writeJson(STATE, this.last); } }
}

// The rules (§7). `s` is a plain snapshot of the system; returns the alerts that apply right now.
export function evaluate(s, cfg = {}) {
  const c = { downMin: 2, drawdownPct: 20, spendFrac: 0.8, offBrier: 0.1, offMinN: 20, ...cfg }, out = [];
  if (s.downMin != null && s.downMin > c.downMin) out.push({ key: "daemon-down", title: "Kalshi daemon was down", body: `No heartbeat for ${Math.round(s.downMin)} min before this restart.`, priority: "high", cooldownMin: 10 });
  if (s.streamDownSec != null && s.streamDownSec > c.downMin * 60) out.push({ key: "stream-down", title: "Kalshi live stream is down", body: `WebSocket disconnected for ${Math.round(s.streamDownSec / 60)} min; running on REST fallback.`, priority: "high", cooldownMin: 30 });
  for (const [k, p] of Object.entries(s.predictors || {})) {
    // The weather-bug pattern: a predictor far worse than the market on a meaningful sample.
    if (p.on !== false && p.n >= c.offMinN && p.vsMarket != null && p.vsMarket > c.offBrier) out.push({ key: `off-${k}`, title: `Predictor ${k} is wildly off`, body: `Brier ${p.vsMarket > 0 ? "+" : ""}${p.vsMarket} vs market over ${p.n} resolved. It has been switched off.`, priority: "high", cooldownMin: 720, action: { disable: k } });
    if (p.status === "SUCCESS") out.push({ key: `success-${k}`, title: `Model ${k} reached SUCCESS`, body: `${k} beats the market on the peeking-safe test over ${p.n} resolved. Paper trading only; real money needs your yes.`, priority: "high", cooldownMin: 1440 });
  }
  for (const pf of s.portfolios || []) if (pf.maxDrawdownPct > c.drawdownPct) out.push({ key: `dd-${pf.id}`, title: `Paper drawdown ${Math.round(pf.maxDrawdownPct)}%`, body: `${pf.name}: down ${Math.round(pf.maxDrawdownPct)}% from its peak (paper money).`, cooldownMin: 1440 });
  if (s.llm && s.llm.cap > 0 && s.llm.spent >= c.spendFrac * s.llm.cap) out.push({ key: `llm-${s.llm.day}`, title: "LLM spend at 80% of the daily cap", body: `$${s.llm.spent.toFixed(2)} of $${s.llm.cap.toFixed(2)} used today.`, cooldownMin: 1440 });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [title = "Kalshi feed", body = "test alert"] = process.argv.slice(2);
  console.log(await new Alerts().raise(`cli-${title}`, title, body, { cooldownMin: 1, priority: "high" }) ? (target() ? "alert sent" : "alert recorded (no private/alerts.json, so nothing was sent)") : "suppressed (cooldown)");
}
