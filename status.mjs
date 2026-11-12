// Watchdog + plain-English status (code, free, every run). Answers four questions for the owner:
//   Should I trade?  Is it learning?  Is it running (and is data moving between steps)?  What do you need from me?
// Checks data hand-offs between steps so a silent break is caught on the next run. Writes status.json.
import { config, readJson, readJsonl, marketUrl } from "./lib.mjs";

export function run(ctx) {
const now = Date.now(), ago = t => (now - Date.parse(t)) / 6e4, G = config.goals.edge, st0 = ctx.store;
const preds = st0.preds, outcomes = st0.outcomes, runs = st0.runs;
const sc = ctx.get("scorecard") || {}, prog = ctx.get("progress") || {}, nn = ctx.get("nn-model", "state") || {}, paper = ctx.get("paper");
const bt = ctx.get("backtest-scorecard") || {}, trainLog = readJsonl("data/nn/train-log.jsonl"), hb = ctx.get("heartbeat");
// ---- Watchdog: each check = { name, ok, detail } ----
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
const last = runs.at(-1), daemon = hb && ago(hb.at) <= 2;
check("Pipeline ran recently", last && ago(last.ts) <= 30, last ? `last scan ${Math.round(ago(last.ts))} min ago (${last.run === "local" || /^(daemon|local)/.test(last.run) ? "owner's computer" : "cloud"})` : "no run recorded");
const cloud3h = runs.filter(r => ago(r.ts) <= 180).length;
check("Scans on schedule (every 10 min)", cloud3h >= 12, `${cloud3h} scans in the last 3 h (expect ~18)`);
check("Live daemon heartbeat", daemon, hb ? `last heartbeat ${Math.round(ago(hb.at) * 60)} s ago from ${hb.host || "?"}${hb.ws ? `, WebSocket ${hb.ws.state}` : ""}` : "no heartbeat (daemon not running; cloud fallback only)");
check("New predictions are being logged", preds.some(p => ago(p.ts) <= 60), `${preds.filter(p => ago(p.ts) <= 60).length} logged in the last hour`);
// Index and commodity markets settle when the official number is published (often hours later), so the rule is 24 h (config.goals.health).
const H = config.goals.health.maxBacklogHours * 60, have = new Set(outcomes.map(o => o.ticker));
const due = preds.filter(p => ago(p.resolvesAt) > H), missing = due.filter(p => !have.has(p.ticker));
const waiting = preds.filter(p => ago(p.resolvesAt) > 0 && ago(p.resolvesAt) <= H && !have.has(p.ticker)).length;
check("Outcomes are being collected", missing.length <= Math.max(5, due.length * 0.02), `${due.length - missing.length}/${due.length} predictions due >${H / 60} h ago have an official result; ${waiting} newer ones awaiting Kalshi's settlement`);
{ const main = preds.filter(p => !p.shadow).length; check("Scorecard matches the logs", sc.predictions === main, `scorecard counts ${sc.predictions}, log has ${main} (+${preds.length - main} shadow rows scored separately)`); }
{ const lk = ctx.get("evals")?.leakage; check("Leakage eval is 0 (no future data in predictions or training)", lk ? lk.total === 0 : (sc.excludedLeakage || 0) === 0, lk ? `${lk.total} violations across ${lk.checks.length} checks` : `leakage ${sc.excludedLeakage || 0}`); }
const dup = st0.dupes;                 // extra rows for an already-logged market (ignored by readers)
check("No duplicate predictions", dup <= preds.length * 0.01, dup ? `${dup} repeat rows ignored (first logged row counts)` : "none");
check("Backtest sample unbiased", !bt.sampleCheck?.warning, bt.sampleCheck ? `YES ${bt.sampleCheck.yesRate} vs price ${bt.sampleCheck.avgPrice}` : "no backtest yet");
check("Network checked in the last 2 h", nn.trained && (ago(nn.trained) <= 120 || now - (ctx.nnState?.lastRun || 0) <= 120 * 6e4), nn.trained ? `trained ${Math.round(ago(nn.trained))} min ago on ${nn.n} markets` : "not trained");
const pfs = [...(paper?.replay?.portfolios || []), ...(paper?.forward?.portfolios || [])];
check("Bet-size safety held (≤5% per bet)", pfs.every(p => (p.maxBetPct || 0) <= config.paper.safety.maxFracPerBet * 100 + 0.01), `largest bet ${Math.max(0, ...pfs.map(p => p.maxBetPct || 0))}%`);
check("Paper money adds up", pfs.every(p => p.equity >= 0 && Number.isFinite(p.equity)), `${pfs.length} portfolios checked`);
const ext = ctx.get("external", "state");
for (const [k, name] of [["crypto", "Coinbase crypto agent"], ["weather", "weather agent"]].filter(([k]) => config.predictors[k === "crypto" ? "crypto_fair" : "weather_idx"]?.on)) {
  const x = ext?.[k];
  check(`Outside data: ${name}`, ext && ago(ext.at) <= 30 && (!x?.tried || x.got > 0), ext ? `${x?.got ?? 0}/${x?.tried ?? 0} markets got an outside estimate, ${Math.round(ago(ext.at))} min ago` : "not run yet");
}
const st = ctx.get("storage");
check("Storage has room (archive + limits)", st && st.ok, st ? `${st.repoMB ?? "?"} MB in GitHub${st.daysToRepoLimit != null ? `, ~${st.daysToRepoLimit} days to ${st.repoLimitMB} MB` : ""} · ${st.archivedFiles} files archived${st.problems?.length ? " · " + st.problems.join("; ") : ""}` : "not measured yet");
const problems = checks.filter(c => !c.ok);

// ---- Should I trade? ----
const preds2 = Object.entries(prog.predictors || {});
const success = preds2.filter(([, p]) => p.status === "SUCCESS").map(([k]) => k);
const events = sc.events || 0;
const trade = success.length
  ? { answer: "Paper-trade candidate", tone: "good", why: `${success.join(", ")} beat the market and made money after fees over ${G.minResolved}+ live markets.`,
      next: "Keep paper trading it with the safety rules for another 100 bets before any real money, and only with your explicit decision." }
  : { answer: "No — don't trade real money yet", tone: "bad",
      why: (ctx.get("evals")?.headline || "Nothing has proven an edge after fees.") + ` Missing evidence: a model whose peeking-safe range stays below zero on ${G.minResolved}+ live markets (${sc.resolved || 0} resolved so far, ${events} events) with picks profitable after fees over ${G.minPicks}+ picks.`,
      next: "Let it keep collecting. The answer changes automatically when a strategy reaches SUCCESS on the live record." };

// ---- Is it learning? ----
const firstLog = trainLog[0], lastLog = trainLog.at(-1);
const learning = [
  `Live record: ${sc.resolved || 0} of ${sc.predictions || 0} predictions resolved so far (${events} separate events).`,
  ...preds2.map(([k, p]) => `${k}: ${String(p.status).replace(/_/g, " ").toLowerCase()} — ${p.rec}`),
  nn.oos ? `Neural network: tested on ${nn.oos.n} past markets it never saw → ${nn.oos.verdict} (Brier ${nn.oos.brierNN} vs market ${nn.oos.brierMarket}).` : "Neural network: not trained yet.",
  firstLog && lastLog && trainLog.length > 1 ? `Training history: ${trainLog.length} runs; data grew ${firstLog.n} → ${lastLog.n} markets; gap vs market ${firstLog.oosDiff} → ${lastLog.oosDiff} (below 0 = better than market).` : "Training history: first run, no trend yet.",
  nn.oos?.folds?.length ? `Network learning check: gap vs market by amount of training data ${nn.oos.folds.map(f => `${f.trainN}→${f.gap >= 0 ? "+" : ""}${f.gap}`).join(", ")} (shrinking = learning; ~0 = copying the market).` : "Network learning check: not available yet.",
  `Backtest: ${st0.backtest.length} past markets scored.`,
  nn.sources ? `Network data: ${nn.sources.live} live + ${nn.sources.backtest} backtest markets${nn.sources.minuteSnapshots ? ` + ${nn.sources.minuteSnapshots} minute snapshots from ${nn.sources.minuteMarkets} markets (24/7 streamer)` : ""}${nn.sources.archivedFiles ? `, including ${nn.sources.archivedFiles} archived month files` : ""} — it reads the whole history, nothing is dropped.` : "Network data: not trained yet.",
];

// ---- Paper watchlist: what the strategies would bet on right now (open live predictions with a pick). Not advice. ----
const open = preds.filter(p => !have.has(p.ticker) && Date.parse(p.resolvesAt) > now && Object.keys(p.picks || {}).length)
  .sort((a, b) => Date.parse(a.resolvesAt) - Date.parse(b.resolvesAt)).slice(0, 8)
  .map(p => { const [who, pk] = Object.entries(p.picks).sort((a, b) => b[1].ev - a[1].ev)[0];
    return { title: p.title, cat: p.cat, resolvesAt: p.resolvesAt, predictor: who, status: prog.predictors?.[who]?.status || "NOT_YET_SCORED", side: pk.side, price: pk.cost, ev: pk.ev,
      url: marketUrl(p.series) }; });

// ---- What do you need from me? ----
const needs = [];
if (!daemon) needs.push("The live daemon isn't running on your computer. Start it with start.sh (Mac/Linux) or start.cmd (Windows); see docs/manual.md. Until then only the 10-minute cloud fallback runs.");
for (const p of problems.filter(c => !/schedule|ran recently|heartbeat/i.test(c.name))) needs.push(`Check: ${p.name} (${p.detail}). Ask Claude to run kalshi-ops-status.`);
preds2.filter(([, p]) => /^FAILURE/.test(p.status || "")).forEach(([k, p]) => needs.push(`FYI: ${k} — ${p.rec} (the agent decides; see docs/lessons.md)`));

ctx.emit("status", { updated: new Date(now).toISOString(), trade, learning, watchlist: open, checks, problems: problems.length, needs });
return (`status: ${trade.answer}; watchdog ${checks.length - problems.length}/${checks.length} ok${problems.length ? " — " + problems.map(p => p.name).join("; ") : ""}; needs ${needs.length}`);
}
if (import.meta.url === `file://${process.argv[1]}`) { const { makeCtx } = await import("./core/ctx.mjs"); console.log(run(makeCtx())); }
