// Saving results to GitHub, two ways:
//   main  = code + append-only logs (data/). Committed normally, every ~15 minutes.
//   site  = derived files (site/: scorecard, status, dashboard data, live prices) + the dashboard page. ONE commit,
//           force-pushed, so the branch never grows. GitHub Pages serves it (Settings → Pages → branch `site`, folder /).
// The working tree is never switched: the site commit is built with git plumbing and a separate index.
// NO_PUSH=1 turns both off (local testing).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { config } from "./lib.mjs";

const git = (args, env = {}, cwd = undefined) => { const r = spawnSync("git", args, { encoding: "utf8", cwd, env: { ...process.env, ...env } }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
export const NO_PUSH = () => process.env.NO_PUSH === "1";
const BRANCH = config.publish?.siteBranch || "site";
const STATIC = ["dashboard.html", "manifest.webmanifest", "sw.js", "icon.svg"];    // copied next to the data when present

function identity() {
  if (!git(["config", "user.email"]).out) { git(["config", "user.name", "kalshi-feed-bot"]); git(["config", "user.email", "actions@users.noreply.github.com"]); }
  git(["config", "merge.keep.driver", "true"]);
}

// Commit new log lines on main and push (rebase onto whatever the other writer pushed; *.jsonl merge as a union).
export function pushMain(reason = "update") {
  if (NO_PUSH()) return "push off (NO_PUSH)";
  identity();
  git(["add", "-A", "data"]);
  if (git(["diff", "--cached", "--quiet"]).ok) return "main: nothing new";
  git(["commit", "-q", "-m", `Logs: ${reason}`]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;
  for (let i = 0; i < 4; i++) {
    if (git(["pull", "--rebase", "-q", "origin", branch]).ok && git(["push", "-q", "origin", `HEAD:${branch}`]).ok) return "main: pushed";
    git(["rebase", "--abort"]); spawnSync(process.execPath, ["-e", `setTimeout(()=>{}, ${2000 * 2 ** i})`]);
  }
  return "main: push FAILED (will retry; check git login / network)";
}

// Build the site tree from site/ and force-push it as a single parentless commit.
export function pushSite(reason = "update") {
  mkdirSync("site", { recursive: true });
  for (const f of STATIC) if (existsSync(f)) copyFileSync(f, `site/${f}`);
  if (existsSync("dashboard.html")) copyFileSync("dashboard.html", "site/index.html");
  writeFileSync("site/.nojekyll", "");
  if (NO_PUSH()) return "site: built (NO_PUSH)";
  identity();
  const gd = git(["rev-parse", "--absolute-git-dir"]).out, env = { GIT_INDEX_FILE: `${gd}/site-index`, GIT_DIR: gd, GIT_WORK_TREE: "." };
  const add = git(["add", "-A", "-f", "."], env, "site");
  if (!add.ok) return `site: git add failed (${add.err.split("\n").pop()})`;
  const tree = git(["write-tree"], env).out;
  if (!tree) return "site: write-tree failed";
  if (tree === pushSite.last) return "site: unchanged";
  const commit = git(["commit-tree", tree, "-m", `Site: ${reason} @ ${new Date().toISOString()}`]).out;
  const r = git(["push", "-q", "-f", "origin", `${commit}:refs/heads/${BRANCH}`]);
  if (r.ok) pushSite.last = tree;
  return r.ok ? "site: pushed" : `site: push FAILED (${r.err.split("\n").pop()})`;
}

// Heartbeat of the owner's daemon, read from the published site branch (used by the cloud fallback to step aside).
export function remoteHeartbeatAgeMin() {
  if (!git(["fetch", "-q", "--depth=1", "origin", BRANCH]).ok) return Infinity;
  try { const at = Date.parse(JSON.parse(git(["show", "FETCH_HEAD:heartbeat.json"]).out).at); return Number.isFinite(at) ? (Date.now() - at) / 6e4 : Infinity; } catch { return Infinity; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const what = process.argv[2];
  if (what === "heartbeat-fresh") process.exit(remoteHeartbeatAgeMin() < 15 ? 0 : 1);
  if (what !== "site") console.log(pushMain(process.argv[3] || "manual"));
  if (what !== "main") console.log(pushSite(process.argv[3] || "manual"));
}
