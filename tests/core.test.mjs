// Store (incremental log reads), per-event network interval, publishing, and an offline run of the derived steps.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../core/store.mjs";
import { trainAll } from "../nn.mjs";
import { FEATURES } from "../nnlib.mjs";
import { config } from "../lib.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const P = (i, extra = {}) => ({ ts: "2026-01-01T10:00:00.000Z", ticker: "T" + i, event: "E" + (i >> 1), series: "S", cat: "Crypto", title: "t" + i, resolvesAt: "2026-01-01T12:00:00.000Z",
  ask: 0.52, bid: 0.48, mid: 0.5, spread: 0.04, est: { market: 0.5 }, picks: {}, cfg: 10, ...extra });
const O = i => ({ ticker: "T" + i, result: i % 2 ? "yes" : "no", settledAt: "2026-01-01T12:05:00Z", closedAt: "2026-01-01T12:00:00Z" });

// ---- Store: loads once, then reads only appended bytes; half-written lines wait; a shrunk file forces a clean reload.
{
  const d = mkdtempSync(tmpdir() + "/store-"); mkdirSync(`${d}/data/predictions`, { recursive: true });
  const pf = `${d}/data/predictions/2026-01.jsonl`, of = `${d}/data/outcomes.jsonl`;
  writeFileSync(pf, [P(1), P(2)].map(x => JSON.stringify(x)).join("\n") + "\n");
  const s = new Store(d);
  assert.equal(s.refresh().predictions.length, 2);
  assert.deepEqual(s.refresh(), {});                                             // nothing new → nothing parsed
  const half = JSON.stringify(P(3));
  appendFileSync(pf, half.slice(0, 20));
  assert.deepEqual(s.refresh(), {});                                             // partial line is not consumed
  appendFileSync(pf, half.slice(20) + "\n" + JSON.stringify(P(1, { mid: 0.9 })) + "\n");
  assert.equal(s.refresh().predictions.length, 2);
  assert.equal(s.preds.length, 3); assert.equal(s.dupes, 1); assert.equal(s.pred.get("T1").mid, 0.5);   // first logged row counts
  writeFileSync(of, JSON.stringify(O(1)) + "\n");
  assert.equal(s.refresh().outcomes.length, 1); assert.equal(s.result("T1"), 1); assert.equal(s.result("T2"), null);
  assert.equal(s.open(Date.parse("2026-01-01T11:00:00Z")).length, 2);
  const v = s.version; s.append("outcomes", [O(2)]); assert.equal(s.out.size, 2); assert.ok(s.version > v);
  writeFileSync(pf, JSON.stringify(P(1)) + "\n");                                 // file replaced by a shorter one
  s.refresh(); assert.equal(s.preds.length, 1); assert.equal(s.out.size, 2); assert.equal(s.reloads, 1);
}

// ---- Network interval is counted per event: 400 markets in 20 events must report 20 units, not 400.
{
  const data = Array.from({ length: 400 }, (_, i) => ({ ticker: "N" + i, title: "", event: "EV" + (i % 20), src: "backtest", t: i, mid: 0.5, y: (i * 7) % 3 === 0 ? 1 : 0, x: FEATURES.map((_, j) => ((i * (j + 3)) % 11) / 11 - 0.5) }));
  const { file } = trainAll({ data, extra: [], minuteMarkets: 0 });
  assert.equal(file.oos.brierDiff.events, 20); assert.equal(file.oos.events, 20); assert.ok(file.oos.n >= 300);
  assert.ok(file.oos.brierDiff.lo <= file.oos.brierDiff.mean && file.oos.brierDiff.mean <= file.oos.brierDiff.hi);
}

// ---- Config v10: weather and memory are off; longshot stays retired; no portfolio trades a switched-off predictor.
assert.ok(config.version >= 10 && !config.predictors.weather_nws.on && !config.predictors.memory.on && !config.predictors.longshot.on);
for (const pf of config.paper.portfolios) assert.ok(!pf.predictor || pf.predictor === "coin" || config.predictors[pf.predictor]?.on, `portfolio ${pf.id} uses an off predictor`);

// ---- Offline integration: derived steps on a small log, then publish to a local bare remote (main = logs, site = one commit).
{
  const d = mkdtempSync(tmpdir() + "/cycle-"), remote = mkdtempSync(tmpdir() + "/remote-");
  const sh = (cmd, args, cwd = d, env = {}) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }); assert.equal(r.status, 0, `${cmd} ${args.join(" ")}: ${r.stderr}`); return r.stdout; };
  sh("git", ["init", "-q", "--bare", "-b", "main", remote]);
  sh("git", ["init", "-q", "-b", "main", "."]); sh("git", ["config", "user.email", "t@t"]); sh("git", ["config", "user.name", "t"]); sh("git", ["remote", "add", "origin", remote]);
  mkdirSync(`${d}/data/predictions`, { recursive: true });
  writeFileSync(`${d}/.gitignore`, "site/\nstate/\n");
  writeFileSync(`${d}/data/predictions/2026-01.jsonl`, Array.from({ length: 40 }, (_, i) => JSON.stringify(P(i, { est: { market: 0.5, nn: i % 2 ? 0.6 : 0.4 } }))).join("\n") + "\n");
  writeFileSync(`${d}/data/outcomes.jsonl`, Array.from({ length: 40 }, (_, i) => JSON.stringify(O(i))).join("\n") + "\n");
  writeFileSync(`${d}/dashboard.html`, "<!doctype html><title>x</title>");
  sh("git", ["add", "-A"]); sh("git", ["commit", "-q", "-m", "init"]); sh("git", ["push", "-q", "origin", "main"]);
  const code = `import { makeCtx } from ${JSON.stringify(ROOT + "core/ctx.mjs")}; import { derive } from ${JSON.stringify(ROOT + "cycle.mjs")}; import { pushMain, pushSite, remoteHeartbeatAgeMin } from ${JSON.stringify(ROOT + "publish.mjs")};
    const ctx = makeCtx({ log: () => {} }); await derive(ctx);
    ctx.store.append("outcomes", [{ ticker: "T999", result: "void" }]); ctx.emit("heartbeat", { at: new Date().toISOString(), host: "test" });
    console.log(JSON.stringify({ main: pushMain("test"), site: pushSite("test"), again: pushSite("test"), hb: remoteHeartbeatAgeMin(), resolved: ctx.out.scorecard.resolved, nn: ctx.out.scorecard.predictors.nn.brierVsMarket.mean }));`;
  const res = JSON.parse(sh(process.execPath, ["--input-type=module", "-e", code]).trim().split("\n").pop());
  assert.equal(res.resolved, 40); assert.ok(res.nn < 0);
  assert.equal(res.main, "main: pushed"); assert.equal(res.site, "site: pushed"); assert.equal(res.again, "site: unchanged"); assert.ok(res.hb < 1);
  for (const f of ["scorecard", "progress", "status", "app", "evals", "paper"]) assert.ok(existsSync(`${d}/site/${f}.json`), f);
  assert.equal(sh("git", ["rev-list", "--count", "site"], remote).trim(), "1");                       // single parentless commit
  const files = sh("git", ["ls-tree", "--name-only", "site"], remote);
  assert.ok(/index\.html/.test(files) && /scorecard\.json/.test(files) && /\.nojekyll/.test(files));
  assert.ok(!/scorecard\.json|site\//.test(sh("git", ["ls-tree", "-r", "--name-only", "main"], remote)));   // derived files never reach main
  assert.ok(sh("git", ["show", "main:data/outcomes.jsonl"], remote).includes("T999"));
}
