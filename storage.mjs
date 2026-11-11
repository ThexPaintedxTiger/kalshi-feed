// Storage watchdog: how big each storage tier is, how fast the GitHub repo grows, and how long until a limit.
// Writes data/storage.json (+ one row a day in data/storage-history.jsonl). `--mirror` (used by the 24/7 streamer on the
// owner's computer) also keeps an uncompressed copy of every log in local/archive/ (git-ignored, never deleted).
// Code only, free, no network.
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, statfsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { config, readJson, writeJson, readJsonl, appendJsonl, r4, LOG_KINDS } from "./lib.mjs";

const S = { maxHotMB: 40, repoLimitMB: 1024, warnDays: 90, minFreeGB: 5, ...(config.storage || {}) };
const MB = b => r4(b / 1048576);
function dirBytes(d) {
  if (!existsSync(d)) return 0;
  let t = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) t += e.isDirectory() ? dirBytes(`${d}/${e.name}`) : statSync(`${d}/${e.name}`).size;
  return t;
}

// Uncompressed local copy: archived months as their own names, hot files as hot-YYYY-MM.jsonl (refreshed as they grow).
export function mirrorLocal(root = ".") {
  let wrote = 0;
  const put = (dst, buf) => { if (existsSync(dst) && statSync(dst).size === buf.length) return; mkdirSync(dst.slice(0, dst.lastIndexOf("/")), { recursive: true }); writeFileSync(dst, buf); wrote++; };
  for (const k of LOG_KINDS) {
    const a = `${root}/data/archive/${k}`, h = `${root}/data/${k}`;
    if (existsSync(a)) for (const f of readdirSync(a).filter(f => f.endsWith(".jsonl.gz"))) {
      const dst = `${root}/local/archive/${k}/${f.replace(/\.gz$/, "")}`;
      if (!existsSync(dst)) put(dst, gunzipSync(readFileSync(`${a}/${f}`)));
    }
    if (existsSync(h)) for (const f of readdirSync(h).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f))) put(`${root}/local/archive/${k}/hot-${f}`, readFileSync(`${h}/${f}`));
  }
  for (const f of ["outcomes.jsonl", "runs.jsonl"]) if (existsSync(`${root}/data/${f}`)) put(`${root}/local/archive/${f}`, readFileSync(`${root}/data/${f}`));
  return wrote;
}

export function measure(root = ".", now = Date.now(), githubKB = null) {
  const hot = {}, arch = {}, big = [];
  for (const k of LOG_KINDS) {
    hot[k] = dirBytes(`${root}/data/${k}`); arch[k] = dirBytes(`${root}/data/archive/${k}`);
    if (existsSync(`${root}/data/${k}`)) for (const f of readdirSync(`${root}/data/${k}`)) { const s = statSync(`${root}/data/${k}/${f}`).size; if (s > S.maxHotMB * 1048576) big.push(`data/${k}/${f} ${MB(s)} MB`); }
  }
  const g = spawnSync("git", ["count-objects", "-v"], { cwd: root, encoding: "utf8" }).stdout || "";
  const kib = k => +((g.match(new RegExp(`^${k}: (\\d+)`, "m")) || [])[1] || 0);
  // GitHub's own figure for the whole repo when we have it (cloud clones are shallow); else this clone's objects.
  const shallow = (spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8" }).stdout || "").trim() === "true";
  const repoMB = githubKB != null ? r4(githubKB / 1024) : shallow || !g ? null : r4((kib("size") + kib("size-pack")) / 1024);
  let freeGB = null; try { const f = statfsSync(root); freeGB = r4(f.bavail * f.bsize / 1073741824); } catch {}
  const idx = readJson(`${root}/data/archive/index.json`, { files: [], failures: [] });
  // Growth: from the daily history (first vs latest within the last 14 days).
  const hist = readJsonl(`${root}/data/storage-history.jsonl`).filter(h => now - Date.parse(h.date) <= 14 * 864e5);
  const first = hist[0], days = first ? (now - Date.parse(first.date)) / 864e5 : 0;
  const perDay = first && days >= 1 && repoMB != null && first.repoMB != null ? r4((repoMB - first.repoMB) / days) : null;
  const daysToLimit = perDay > 0 ? Math.round((S.repoLimitMB - repoMB) / perDay) : null;
  return {
    at: new Date(now).toISOString(),
    hotMB: Object.fromEntries(LOG_KINDS.map(k => [k, MB(hot[k])])), archiveMB: Object.fromEntries(LOG_KINDS.map(k => [k, MB(arch[k])])),
    archivedFiles: idx.files.length, archiveRows: idx.files.reduce((s, f) => s + f.rows, 0), archiveSavedMB: MB(idx.files.reduce((s, f) => s + f.bytes - f.gzBytes, 0)),
    archiveFailures: idx.failures || [], oversizeHot: big,
    repoMB, repoGrowthMBPerDay: perDay, daysToRepoLimit: daysToLimit, repoLimitMB: S.repoLimitMB,
    localCopyMB: MB(dirBytes(`${root}/local/archive`)), ticksMB: MB(dirBytes(`${root}/local/ticks`)), freeDiskGB: freeGB,
    limits: S,
  };
}

// Plain verdict for the watchdog.
export function verdict(m, onOwnerComputer = false) {
  const p = [];
  if (m.oversizeHot.length) p.push(`hot file over ${m.limits.maxHotMB} MB: ${m.oversizeHot.join(", ")}`);
  if (m.archiveFailures.length) p.push(`archive failed: ${m.archiveFailures.map(f => f.src).join(", ")}`);
  if (m.daysToRepoLimit != null && m.daysToRepoLimit < m.limits.warnDays) p.push(`repo reaches ${m.limits.repoLimitMB} MB in ~${m.daysToRepoLimit} days: commit dashboard.json/history.json hourly instead of every cycle (owner approves)`);
  if (onOwnerComputer && m.freeDiskGB != null && m.freeDiskGB < m.limits.minFreeGB) p.push(`only ${m.freeDiskGB} GB free on this computer`);
  return { ok: p.length === 0, problems: p };
}

// Public repo metadata (no key): GitHub's size of the whole repo in KB. Null when offline or rate-limited.
async function githubSizeKB() {
  const u = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).stdout || "", m = u.match(/github\.com[/:]([^/]+\/[^/.\s]+)/);
  if (!m) return null;
  try { const r = await fetch(`https://api.github.com/repos/${m[1]}`, { headers: { accept: "application/vnd.github+json", "user-agent": "kalshi-feed-storage" } }); return r.ok ? (await r.json()).size ?? null : null; } catch { return null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const local = process.argv.includes("--mirror");
  const copied = local ? mirrorLocal() : 0;
  const m = measure(".", Date.now(), await githubSizeKB()), v = verdict(m, local);
  m.ok = v.ok; m.problems = v.problems; m.host = local ? "local" : (process.env.GITHUB_ACTIONS ? "cloud" : "other");
  writeJson("data/storage.json", m);
  const today = m.at.slice(0, 10);
  if (!readJsonl("data/storage-history.jsonl").some(h => h.date === today)) appendJsonl("data/storage-history.jsonl", [{ date: today, repoMB: m.repoMB, hotMB: m.hotMB, archiveMB: m.archiveMB }]);
  console.log(`storage: repo ${m.repoMB} MB${m.repoGrowthMBPerDay != null ? ` (+${m.repoGrowthMBPerDay} MB/day, ~${m.daysToRepoLimit ?? "∞"} days to ${m.repoLimitMB} MB)` : ""} · ` +
    `hot ${Object.values(m.hotMB).reduce((a, b) => a + b, 0).toFixed(1)} MB · archive ${m.archivedFiles} files (${m.archiveRows} rows)` +
    (local ? ` · local copy ${m.localCopyMB} MB (${copied} files updated) · ${m.freeDiskGB} GB free` : "") + (v.ok ? " · ok" : ` · CHECK: ${v.problems.join("; ")}`));
}
