// Archive tier: moves old or large hot log files into data/archive/<kind>/ as gzip, losslessly.
// A month moves when it is older than last month, or when its hot file passes config.storage.maxHotMB (split into parts, so
// no file nears GitHub's 100 MB limit). The gzip is decompressed and checked (same rows, same SHA-256) BEFORE the hot file
// is removed; on any mismatch the hot file stays and the failure is recorded for the watchdog. Rows are never changed.
// Readers (lib.mjs allMonthFiles/readJsonl) see hot + archive as one history, so nothing is forgotten. Code only, free.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { config, readJson, writeJson, MONTH_FILE, LOG_KINDS } from "./lib.mjs";

const sha = b => createHash("sha256").update(b).digest("hex");

// Move one hot file into the archive. Returns the index entry, or throws (hot file untouched).
export function archiveFile(src, kind, ym, root = ".") {
  const dir = `${root}/data/archive/${kind}`; mkdirSync(dir, { recursive: true });
  const taken = new Set(readdirSync(dir));
  let name = `${ym}.jsonl.gz`;                                              // first archive of a month keeps the plain name
  for (let n = 1; taken.has(name); n++) name = `${ym}.part${n}.jsonl.gz`;   // later moves of the same month become parts
  const raw = readFileSync(src), gz = gzipSync(raw, { level: 9 });
  const back = gunzipSync(gz), rows = n => n.toString("utf8").split("\n").filter(Boolean).length;
  if (sha(back) !== sha(raw) || rows(back) !== rows(raw)) throw new Error(`verify failed for ${src}`);
  writeFileSync(`${dir}/${name}`, gz);
  const check = readFileSync(`${dir}/${name}`);                              // re-read from disk: what was written is what we checked
  if (sha(gunzipSync(check)) !== sha(raw)) { unlinkSync(`${dir}/${name}`); throw new Error(`disk verify failed for ${src}`); }
  unlinkSync(src);
  return { file: `data/archive/${kind}/${name}`, from: src.replace(`${root}/`, ""), rows: rows(raw), bytes: raw.length, gzBytes: gz.length, sha256: sha(raw), archivedAt: new Date().toISOString() };
}

// Which hot files are due: month before last or older, or bigger than maxMB.
export function due(root = ".", now = new Date(), maxMB = config.storage?.maxHotMB ?? 40) {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7), out = [];
  for (const kind of LOG_KINDS) {
    const d = `${root}/data/${kind}`; if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const m = f.match(MONTH_FILE); if (!m || f.endsWith(".gz")) continue;
      const size = statSync(`${d}/${f}`).size;
      if (!size) continue;
      if (m[1] < prev || size > maxMB * 1048576) out.push({ src: `${d}/${f}`, kind, ym: m[1], reason: m[1] < prev ? "old month" : `over ${maxMB} MB` });
    }
  }
  return out;
}

export function run(root = ".", now = new Date()) {
  const idxFile = `${root}/data/archive/index.json`, idx = readJson(idxFile, { files: [], failures: [] });
  const moved = [], failed = [], hadFailures = (idx.failures || []).length > 0;
  for (const d of due(root, now)) {
    try { const e = archiveFile(d.src, d.kind, d.ym, root); e.reason = d.reason; idx.files.push(e); moved.push(e); }
    catch (e) { failed.push({ src: d.src.replace(`${root}/`, ""), error: e.message, at: new Date().toISOString() }); }
  }
  idx.failures = failed;                                                     // only the latest run's failures (watchdog reads this)
  idx.updated = new Date().toISOString();
  if (moved.length || failed.length || hadFailures || !existsSync(idxFile)) writeJson(idxFile, idx);
  return { moved, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { moved, failed } = run();
  console.log(`archive: ${moved.length ? moved.map(m => `${m.from} → ${m.file} (${m.rows} rows, ${(m.bytes / 1048576).toFixed(1)} → ${(m.gzBytes / 1048576).toFixed(1)} MB)`).join("; ") : "nothing due"}` +
    (failed.length ? `; FAILED: ${failed.map(f => `${f.src}: ${f.error}`).join("; ")}` : ""));
  if (failed.length) process.exitCode = 1;
}
