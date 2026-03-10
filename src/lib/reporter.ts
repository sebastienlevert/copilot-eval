import type { EvalRunResults } from "./types.js";

/**
 * Build the summary text for eval results.
 */
export function buildSummary(results: EvalRunResults): string {
  const lines: string[] = [];
  const total = results.evals.length;
  const passed = results.evals.filter((e) => e.judgment?.verdict === "pass").length;
  const partial = results.evals.filter((e) => e.judgment?.verdict === "partial").length;
  const failed = results.evals.filter((e) => e.judgment?.verdict === "fail").length;
  const skipped = results.evals.filter((e) => e.skipped).length;
  const errored = results.evals.filter((e) => e.error && !e.skipped).length;
  const scored = total - skipped;
  const avgScore =
    scored > 0
      ? results.evals.reduce((sum, e) => sum + (e.judgment?.score ?? 0), 0) / scored
      : 0;

  lines.push("\n" + "═".repeat(60));
  lines.push("  EVAL RESULTS");
  lines.push("═".repeat(60));
  lines.push(`  Date:     ${results.timestamp}`);
  lines.push(`  Duration: ${(results.totalDuration / 1000).toFixed(1)}s`);
  if (skipped > 0) {
    lines.push(`  ⚠️  Partial run (interrupted)`);
  }
  lines.push("─".repeat(60));
  lines.push(
    `  Total: ${total}  ` +
    `✅ Pass: ${passed}  ` +
    `🟡 Partial: ${partial}  ` +
    `❌ Fail: ${failed}  ` +
    `💥 Error: ${errored}` +
    (skipped > 0 ? `  ⏭️ Skipped: ${skipped}` : ""),
  );
  lines.push(`  Average Score: ${avgScore.toFixed(1)}/100${skipped > 0 ? ` (${scored} scored)` : ""}`);
  lines.push("─".repeat(60));

  for (const [i, evalResult] of results.evals.entries()) {
    const icon =
      evalResult.skipped ? "⏭️" :
      evalResult.error ? "💥" :
      evalResult.judgment?.verdict === "pass" ? "✅" :
      evalResult.judgment?.verdict === "partial" ? "🟡" : "❌";
    const score = evalResult.skipped ? "---" : (evalResult.judgment?.score ?? "ERR");
    const title =
      evalResult.title.length > 50
        ? evalResult.title.slice(0, 47) + "..."
        : evalResult.title;
    const duration = evalResult.duration
      ? `${(evalResult.duration / 1000).toFixed(1)}s`
      : "N/A";
    const turnCount = evalResult.turns.length;
    const turnLabel = turnCount > 1 ? ` (${turnCount} turns)` : "";

    lines.push(`  ${icon} [${String(i).padStart(2)}] (${String(score).padStart(3)}) ${title}${turnLabel}  ${duration}`);

    if (!evalResult.skipped) {
      for (const [ti, turn] of evalResult.turns.entries()) {
        const turnPrompt =
          turn.prompt.length > 55
            ? turn.prompt.slice(0, 52) + "..."
            : turn.prompt;
        lines.push(`       ↳ Turn ${ti + 1}: ${turnPrompt}`);
      }
    }

    if (evalResult.judgment?.criteria_missed?.length) {
      for (const missed of evalResult.judgment.criteria_missed) {
        lines.push(`       ↳ Missing: ${missed}`);
      }
    }

    if (evalResult.error && !evalResult.skipped) {
      lines.push(`       ↳ Error: ${evalResult.error}`);
    }
  }

  lines.push("═".repeat(60));

  const passRate = scored > 0 ? ((passed / scored) * 100).toFixed(1) : "0.0";
  const passPartialRate = scored > 0 ? (((passed + partial) / scored) * 100).toFixed(1) : "0.0";
  lines.push(`  Pass Rate:          ${passRate}%${skipped > 0 ? ` (of ${scored} completed)` : ""}`);
  lines.push(`  Pass+Partial Rate:  ${passPartialRate}%${skipped > 0 ? ` (of ${scored} completed)` : ""}`);
  lines.push("═".repeat(60));

  return lines.join("\n");
}

/**
 * Print a summary of eval results to the console.
 */
export function printSummary(results: EvalRunResults): void {
  console.log(buildSummary(results));
}
