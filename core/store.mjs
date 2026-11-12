// In-memory copy of the append-only logs, loaded once and then extended by reading only the bytes appended since the last
// look (no re-parsing of whole files every cycle). One Store is shared by every step in a process.
// Rows are never edited: the files stay the source of truth, this is a read cache.
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { allMonthFiles, readJsonl, appendJsonl, hotFile, LOG_KINDS } from "../lib.mjs";

const FLAT = { outcomes: "data/outcomes.jsonl", runs: "data/runs.jsonl" };

export class Store {
  constructor(root = ".") { this.root = root; this.reset(); }
  reset() {
    this.files = new Map();                                    // path → { off, kind }
    this.logs = Object.fromEntries([...LOG_KINDS, ...Object.keys(FLAT)].map(k => [k, []]));
    this.pred = new Map(); this.preds = []; this.dupes = 0;    // first logged row per ticker (later repeats ignored)
    this.out = new Map();                                      // ticker → outcome row (first one wins)
    this.version = 0; this.reloads = (this.reloads ?? -1) + 1;
  }
  path(p) { return this.root === "." ? p : `${this.root}/${p}`; }
  // New complete lines of one file since the last read. A half-written last line is left for next time.
  tail(p, kind) {
    const full = this.path(p), f = this.files.get(p) || { off: 0, kind };
    if (p.endsWith(".gz")) { if (f.off) return []; f.off = 1; this.files.set(p, f); return readJsonl(full); }
    const size = statSync(full).size; if (size <= f.off) return [];
    const buf = Buffer.alloc(size - f.off), fd = openSync(full, "r");
    try { readSync(fd, buf, 0, buf.length, f.off); } finally { closeSync(fd); }
    const end = buf.lastIndexOf(10); if (end < 0) return [];
    f.off += end + 1; this.files.set(p, f);
    const rows = [];
    for (const l of buf.subarray(0, end).toString("utf8").split("\n")) { if (!l) continue; try { rows.push(JSON.parse(l)); } catch { this.badLines = (this.badLines || 0) + 1; } }
    return rows;
  }
  // Read whatever was appended. Returns the new rows per kind. A tracked file that vanished or shrank (archived, or a
  // git pull rewrote it) triggers one full reload, so the cache can never drift from the files.
  refresh() {
    for (const [p, f] of this.files) {
      const full = this.path(p);
      if (!existsSync(full) || (!p.endsWith(".gz") && statSync(full).size < f.off)) { this.reset(); break; }
    }
    const fresh = {};
    const take = (kind, rows) => { if (!rows.length) return; (fresh[kind] ||= []).push(...rows); this.logs[kind].push(...rows); };
    for (const kind of LOG_KINDS) for (const p of allMonthFiles(kind, null, this.root)) take(kind, this.tail(p, kind));
    for (const [kind, p] of Object.entries(FLAT)) if (existsSync(this.path(p))) take(kind, this.tail(p, kind));
    for (const r of fresh.predictions || []) { if (this.pred.has(r.ticker)) this.dupes++; else { this.pred.set(r.ticker, r); this.preds.push(r); } }
    for (const o of fresh.outcomes || []) if (!this.out.has(o.ticker)) this.out.set(o.ticker, o);
    if (Object.keys(fresh).length) this.version++;
    return fresh;
  }
  append(kind, rows, now = new Date()) {
    if (!rows.length) return {};
    if (kind in FLAT) appendJsonl(this.path(FLAT[kind]), rows);
    else { const by = {}; for (const r of rows) (by[kind === "predictions" ? hotFile(kind, now) : `data/${kind}/${String(r.ts).slice(0, 7)}.jsonl`] ||= []).push(r);
      for (const [f, rs] of Object.entries(by)) appendJsonl(this.path(f), rs); }
    return this.refresh();
  }
  result(ticker) { const r = this.out.get(ticker)?.result; return r === "yes" ? 1 : r === "no" ? 0 : null; }
  get backtest() { return this.logs.backtest; }
  get snapshots() { return this.logs.snapshots; }
  get outcomes() { return this.logs.outcomes; }
  get runs() { return this.logs.runs; }
  // Logged, not yet resolved, and not past resolution by more than `graceMs`.
  open(now = Date.now(), graceMs = 5 * 6e4) { return this.preds.filter(p => !this.out.has(p.ticker) && Date.parse(p.resolvesAt) > now - graceMs); }
}
