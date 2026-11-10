// Minute snapshots: turns the 24/7 streamer's minute price log (local/ticks/, owner's computer) into extra training rows
// for the neural network. For each watched market that has resolved, it takes the market as it looked 60, 30, 15 and 5
// minutes before resolution: price, spread, 30-minute move and minute volatility, computed ONLY from ticks at or
// before that moment, plus the official outcome. Rows go to data/snapshots/YYYY-MM.jsonl (pushed, ~4 per market).
// They are training-only (never scored as predictions). Code only, free, no API calls.
import { existsSync, readdirSync } from "node:fs";
import { readJsonl, appendJsonl, hotFile, predictionFiles, r4, config } from "./lib.mjs";
import { minuteStats } from "./nnlib.mjs";
import { snapshotRows } from "./memory.mjs";

export const LEADS = [60, 30, 15, 5];
const MAX_QUOTE_AGE = 180;                                                   // seconds: the last tick must be this fresh at T

// ticks: [{t: ISO, k: ticker, b, a}]; meta: ticker → logged prediction row; out: ticker → "yes"/"no"; done: Set("ticker|lead").
export function buildSnapshots(ticks, meta, out, done = new Set(), leads = LEADS) {
  const by = {};
  for (const x of ticks) if (meta[x.k] && (out[x.k] === "yes" || out[x.k] === "no") && x.b > 0 && x.a < 1 && x.a > x.b)
    (by[x.k] ||= []).push({ t: Date.parse(x.t) / 1000, bid: x.b, ask: x.a, mid: (x.a + x.b) / 2 });
  const rows = [];
  for (const [k, pts] of Object.entries(by)) {
    pts.sort((a, b) => a.t - b.t);
    const p = meta[k], res = Date.parse(p.resolvesAt) / 1000;
    for (const lead of leads) {
      if (done.has(`${k}|${lead}`)) continue;
      const T = res - lead * 60, upto = pts.filter(x => x.t <= T), q = upto.at(-1);   // nothing after T is used
      if (!q || T - q.t > MAX_QUOTE_AGE) continue;
      const { chg30, vol30 } = minuteStats(upto, T);
      rows.push({ ts: new Date(T * 1000).toISOString(), ticker: k, event: p.event, series: p.series, cat: p.cat, title: p.title,
        resolvesAt: p.resolvesAt, leadMin: lead, bid: q.bid, ask: q.ask, mid: r4(q.mid), spread: r4(q.ask - q.bid), chg30, vol30,
        y: out[k] === "yes" ? 1 : 0, ticks: upto.length, src: "minute", cfg: config.version });
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = "local/ticks";
  if (!existsSync(dir)) { console.log("snapshots: no minute log on this machine (the 24/7 streamer writes it)"); process.exit(0); }
  const out = Object.fromEntries(readJsonl("data/outcomes.jsonl").map(o => [o.ticker, o.result]));
  const meta = Object.fromEntries(predictionFiles().flatMap(f => readJsonl(f)).map(p => [p.ticker, p]));
  const done = new Set(snapshotRows().map(r => `${r.ticker}|${r.leadMin}`));
  // Only the last 2 days of ticks: markets resolve within hours of being watched, so older days are already done.
  const files = readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2);
  const rows = buildSnapshots(files.flatMap(f => readJsonl(`${dir}/${f}`)), meta, out, done);
  appendJsonl(hotFile("snapshots"), rows);
  console.log(`snapshots: ${rows.length} new minute snapshots from ${new Set(rows.map(r => r.ticker)).size} resolved markets (${done.size + rows.length} total)`);
}
