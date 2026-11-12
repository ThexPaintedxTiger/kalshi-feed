// Hourly language-model jobs, in one place: memory index, news facts, LLM evals, daily briefing, spend summary.
// Everything degrades to "skipped" when no local model is running; nothing here can spend more than the daily cap.
import * as rag from "./rag.mjs";
import * as news from "./external/news.mjs";
import * as llmEval from "./evals/llm-eval.mjs";
import { briefing, estimate } from "./agent.mjs";
import { usageToday, localAvailable } from "./llm.mjs";

export async function run(ctx, { deps } = {}) {
  const out = [], up = deps ? true : await localAvailable();
  ctx.llmEstimate = up ? (c, r) => estimate(c, r, deps) : null;                  // predict.mjs uses this for the `llm` predictor
  if (up) out.push(await news.run(ctx, { deps }));
  out.push(await rag.run(ctx, deps?.embedFn ? { embedFn: deps.embedFn } : {}));
  if (up) { out.push(await llmEval.run(ctx, { deps })); }
  const b = await briefing(ctx, deps); if (b) out.push(`briefing written (${b.by})`);
  ctx.emit("llm-usage", usageToday(), "state");
  return out.filter(Boolean).join("\n") + (up ? "" : "\nllm: no local model running — news, llm predictor and LLM evals skipped (install Ollama; see docs/manual.md)");
}
