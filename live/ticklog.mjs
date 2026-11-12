// Append-only compressed logs on the owner's computer (local/, never pushed):
//   local/ticks/YYYY-MM-DD.jsonl.gz     top-of-book changes and trades for every watched market
//   local/features/YYYY-MM-DD.jsonl.gz  one feature row per market per minute
//   local/raw/YYYY-MM-DD.jsonl.gz       every stream message as received (only with RECORD_RAW=1; used for replay tests)
// Each flush appends one complete gzip member, so a crash can lose at most the last few seconds and never corrupts
// what was written before. readGz() reads a whole day back (all members).
import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

export class GzLog {
  constructor(dir, { flushRows = 2000 } = {}) { this.dir = dir; this.buf = []; this.day = null; this.flushRows = flushRows; this.rows = 0; this.bytes = 0; }
  add(rows, t) { const day = new Date(t).toISOString().slice(0, 10); if (this.day && day !== this.day) this.flush(); this.day = day; for (const r of rows) this.buf.push(JSON.stringify(r)); if (this.buf.length >= this.flushRows) this.flush(); }
  flush() {
    if (!this.buf.length) return 0;
    const gz = gzipSync(this.buf.join("\n") + "\n", { level: 6 }), n = this.buf.length;
    mkdirSync(this.dir, { recursive: true }); appendFileSync(`${this.dir}/${this.day}.jsonl.gz`, gz);
    this.rows += n; this.bytes += gz.length; this.buf = []; return n;
  }
}
export function readGz(file) { return existsSync(file) ? gunzipSync(readFileSync(file)).toString("utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []; }
export const days = dir => (existsSync(dir) ? readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f)).sort() : []);
