// Watchdog + plain-English status (code, free, every run). Answers four questions for the owner:
//   Should I trade?  Is it learning?  Is it running (and is data moving between steps)?  What do you need from me?
// Checks data hand-offs between steps so a silent break is caught on the next run. Writes status.json.
import { config, readJson, readJsonl, writeJson } from "./lib.mjs";
import { allPredictions, backtestRows } from "./memory.mjs";

const now = Date.now(), ago = t => (now - Date.parse(t)) / 6e4, G = config.goals.edge;
const preds = allPredictions(), outcomes = readJsonl("data/outcomes.jsonl"), runs = readJsonl("data/runs.jsonl");
const sc = readJson("scorecard.json", {}), prog = readJson("progress.json", {}), nn = readJson("data/nn/model.json", {}), paper = readJson("data/paper/portfolios.json", null);
const bt = readJson("backtest-scorecard.json", {}), trainLog = readJsonl("data/nn/train-log.jsonl");

// ---- Watchdog: each check = { name, ok, detail } ----
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
const cloud = runs.filter(r => r.run !== "local"), lastCloud = cloud.at(-1);
check("Pipeline ran recently", lastCloud && ago(lastCloud.ts) <= 30, lastCloud ? `last cloud run ${Math.round(ago(lastCloud.ts))} min ago` : "no cloud run recorded");
const cloud3h = cloud.filter(r => ago(r.ts) <= 180).length;
check("Runs on schedule (every 10 min)", cloud3h >= 12, `${cloud3h} cloud runs in the last 3 h (expect ~18)`);
check("New predictions are being logged", preds.some(p => ago(p.ts) <= 60), `${preds.filter(p => ago(p.ts) <= 60).length} logged in the last hour`);
// Index and commodity markets settle when the official number is published (often hours later), so the rule is 24 h (config.goals.health).
const H = config.goals.health.maxBacklogHours * 60, have = new Set(outcomes.map(o => o.ticker));
const due = preds.filter(p => ago(p.resolvesAt) > H), missing = due.filter(p => !have.has(p.ticker));
const waiting = preds.filter(p => ago(p.resolvesAt) > 0 && ago(p.resolvesAt) <= H && !have.has(p.ticker)).length;
check("Outcomes are being collected", missing.length <= Math.max(5, due.length * 0.02), `${due.length - missing.length}/${due.length} predictions due >${H / 60} h ago have an official result; ${waiting} newer ones awaiting Kalshi's settlement`);
check("Scorecard matches the logs", sc.predictions === preds.length, `scorecard counts ${sc.predictions}, log has ${preds.length}`);
check("No prediction logged after its market resolved", (sc.excludedLeakage || 0) === 0, `leakage ${sc.excludedLeakage || 0}`);
const dup = preds.length - new Set(preds.map(p => p.ticker)).size;
check("No duplicate predictions", dup === 0, `${dup} duplicates`);
check("Backtest sample unbiased", !bt.sampleCheck?.warning, bt.sampleCheck ? `YES ${bt.sampleCheck.yesRate} vs price ${bt.sampleCheck.avgPrice}` : "no backtest yet");
check("Network trained in the last 2 h", nn.trained && ago(nn.trained) <= 120, nn.trained ? `trained ${Math.round(ago(nn.trained))} min ago on ${nn.n} markets` : "not trained");
const pfs = [...(paper?.replay?.portfolios || []), ...(paper?.forward?.portfolios || [])];
check("Bet-size safety held (≤5% per bet)", pfs.every(p => (p.maxBetPct || 0) <= config.paper.safety.maxFracPerBet * 100 + 0.01), `largest bet ${Math.max(0, ...pfs.map(p => p.maxBetPct || 0))}%`);
check("Paper money adds up", pfs.every(p => p.equity >= 0 && Number.isFinite(p.equity)), `${pfs.length} portfolios checked`);
const ext = readJson("data/external/last.json", null);
for (const [k, name] of [["crypto", "Coinbase crypto agent"], ["weather", "NWS weather agent"]]) {
  const x = ext?.[k];
  check(`Outside data: ${name}`, ext && ago(ext.at) <= 30 && (!x?.tried || x.got > 0), ext ? `${x?.got ?? 0}/${x?.tried ?? 0} markets got an outside estimate, ${Math.round(ago(ext.at))} min ago` : "not run yet");
}
const problems = checks.filter(c => !c.ok);

// ---- Should I trade? ----
const preds2 = Object.entries(prog.predictors || {});
const success = preds2.filter(([, p]) => p.status === "SUCCESS").map(([k]) => k);
const events = sc.events || 0;
const trade = success.length
  ? { answer: "Paper-trade candidate", tone: "good", why: `${success.join(", ")} beat the market and made money after fees over ${G.minResolved}+ live markets.`,
      next: "Keep paper trading it with the safety rules for another 100 bets before any real money, and only with your explicit decision." }
  : { answer: "No — don't trade real money yet", tone: "bad",
      why: `Nothing has proven an edge after fees. Live: ${sc.resolved || 0} markets resolved (${events} events); a verdict needs ${G.minResolved}+ and the 95% range must exclude zero. Network on unseen past markets: ${nn.oos?.verdict || "not tested yet"}.`,
      next: "Let it keep collecting. The answer changes automatically when a strategy reaches SUCCESS on the live record." };

// ---- Is it learning? ----
const firstLog = trainLog[0], lastLog = trainLog.at(-1);
const learning = [
  `Live record: ${sc.resolved || 0} of ${sc.predictions || 0} predictions resolved so far (${events} separate events).`,
  ...preds2.map(([k, p]) => `${k}: ${p.status.replace(/_/g, " ").toLowerCase()} — ${p.rec}`),
  nn.oos ? `Neural network: tested on ${nn.oos.n} past markets it never saw → ${nn.oos.verdict} (Brier ${nn.oos.brierNN} vs market ${nn.oos.brierMarket}).` : "Neural network: not trained yet.",
  firstLog && lastLog && trainLog.length > 1 ? `Training history: ${trainLog.length} runs; data grew ${firstLog.n} → ${lastLog.n} markets; gap vs market ${firstLog.oosDiff} → ${lastLog.oosDiff} (below 0 = better than market).` : "Training history: first run, no trend yet.",
  nn.oos?.folds?.length ? `Network learning check: gap vs market by amount of training data ${nn.oos.folds.map(f => `${f.trainN}→${f.gap >= 0 ? "+" : ""}${f.gap}`).join(", ")} (shrinking = learning; ~0 = copying the market).` : "Network learning check: not available yet.",
  `Backtest: ${backtestRows().length} past markets scored.`,
];

// ---- Paper watchlist: what the strategies would bet on right now (open live predictions with a pick). Not advice. ----
const open = preds.filter(p => !have.has(p.ticker) && Date.parse(p.resolvesAt) > now && Object.keys(p.picks || {}).length)
  .sort((a, b) => Date.parse(a.resolvesAt) - Date.parse(b.resolvesAt)).slice(0, 8)
  .map(p => { const [who, pk] = Object.entries(p.picks).sort((a, b) => b[1].ev - a[1].ev)[0];
    return { title: p.title, cat: p.cat, resolvesAt: p.resolvesAt, predictor: who, status: prog.predictors?.[who]?.status || "NOT_YET_SCORED", side: pk.side, price: pk.cost, ev: pk.ev,
      url: "https://kalshi.com/markets/" + String(p.series || "").toLowerCase() }; });

// ---- What do you need from me? ----
const needs = [];
if (cloud3h < 12) needs.push("Scheduled runs aren't firing. In the repo: Actions → Kalshi feed → ⋯ → Disable workflow, then Enable workflow. Until then data only updates when a run is started by hand.");
for (const p of problems.filter(c => !/schedule|ran recently/i.test(c.name))) needs.push(`Check: ${p.name} (${p.detail}). Ask Claude to run kalshi-ops-status.`);
preds2.filter(([, p]) => p.status.startsWith("FAILURE")).forEach(([k, p]) => needs.push(`Decision: ${k} — ${p.rec}`));

writeJson("status.json", { updated: new Date(now).toISOString(), trade, learning, watchlist: open, checks, problems: problems.length, needs });
console.log(`status: ${trade.answer}; watchdog ${checks.length - problems.length}/${checks.length} ok${problems.length ? " — " + problems.map(p => p.name).join("; ") : ""}; needs ${needs.length}`);
