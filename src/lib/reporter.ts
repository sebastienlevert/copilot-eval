import type { EvalResult, EvalRunResults } from "./types.js";

/** Composite score: prefer finalScore (judge + assertions) over raw judge score. */
function effectiveScore(e: EvalResult): number | null {
  if (typeof e.finalScore === "number") return e.finalScore;
  if (e.judgment) return e.judgment.score;
  return null;
}

/** Verdict derived from the composite score. Mirrors cli.ts thresholds. */
function effectiveVerdict(e: EvalResult): "pass" | "partial" | "fail" | null {
  const s = effectiveScore(e);
  if (s === null) return null;
  if (s >= 90) return "pass";
  if (s >= 60) return "partial";
  return "fail";
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stddev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

/**
 * Build the summary text for eval results.
 */
export function buildSummary(results: EvalRunResults): string {
  const lines: string[] = [];
  const repeats = results.repeats ?? 1;
  const total = results.evals.length;
  const passed = results.evals.filter((e) => effectiveVerdict(e) === "pass").length;
  const partial = results.evals.filter((e) => effectiveVerdict(e) === "partial").length;
  const failed = results.evals.filter((e) => effectiveVerdict(e) === "fail").length;
  const skipped = results.evals.filter((e) => e.skipped).length;
  const errored = results.evals.filter((e) => e.error && !e.skipped).length;
  // Errored evals are infrastructure failures (transient CLI/API errors) and
  // should not count against skill quality. Exclude them from the scored set
  // alongside skipped evals.
  const scored = total - skipped - errored;
  const avgScore =
    scored > 0
      ? results.evals
          .filter((e) => !e.skipped && !e.error)
          .reduce((sum, e) => sum + (effectiveScore(e) ?? 0), 0) / scored
      : 0;
  const partialRun = skipped > 0 || errored > 0;
  const scoredLabel = partialRun ? ` (${scored} scored)` : "";
  const completedLabel = partialRun ? ` (of ${scored} completed)` : "";

  lines.push("\n" + "═".repeat(60));
  lines.push("  EVAL RESULTS");
  lines.push("═".repeat(60));
  lines.push(`  Date:     ${results.timestamp}`);
  lines.push(`  Duration: ${(results.totalDuration / 1000).toFixed(1)}s`);
  if (repeats > 1) {
    lines.push(`  Repeats:  ${repeats} (${results.evalCount} evals × ${repeats} runs = ${total} total)`);
  }
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
  lines.push(`  Average Score: ${avgScore.toFixed(1)}/100${scoredLabel}`);
  lines.push("─".repeat(60));

  for (const [i, evalResult] of results.evals.entries()) {
    const verdict = effectiveVerdict(evalResult);
    const icon =
      evalResult.skipped ? "⏭️" :
      evalResult.error ? "💥" :
      verdict === "pass" ? "✅" :
      verdict === "partial" ? "🟡" : "❌";
    const score = evalResult.skipped ? "---" : (effectiveScore(evalResult) ?? "ERR");
    const title =
      evalResult.title.length > 50
        ? evalResult.title.slice(0, 47) + "..."
        : evalResult.title;
    const duration = evalResult.duration
      ? `${(evalResult.duration / 1000).toFixed(1)}s`
      : "N/A";
    const turnCount = evalResult.turns.length;
    const turnLabel = turnCount > 1 ? ` (${turnCount} turns)` : "";
    const repeatLabel = repeats > 1 ? ` r${(evalResult.repeatIdx ?? 0) + 1}/${repeats}` : "";
    const a = evalResult.assertions;
    const aLabel = a ? ` [a:${a.passed}/${a.total}]` : "";

    lines.push(`  ${icon} [${String(i).padStart(2)}${repeatLabel}] (${String(score).padStart(3)}) ${title}${turnLabel}${aLabel}  ${duration}`);

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

  // Per-eval aggregation when repeats > 1: group by index, show mean/median/stddev/pass-rate
  if (repeats > 1) {
    lines.push("─".repeat(60));
    lines.push("  AGGREGATED BY EVAL (across repeats)");
    lines.push("─".repeat(60));
    const byIndex = new Map<number, EvalResult[]>();
    for (const r of results.evals) {
      if (!byIndex.has(r.index)) byIndex.set(r.index, []);
      byIndex.get(r.index)!.push(r);
    }
    const indices = [...byIndex.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const runs = byIndex.get(idx)!;
      const scoredRuns = runs.filter((r) => !r.skipped && !r.error && (r.judgment || r.finalScore !== undefined));
      const scores = scoredRuns.map((r) => effectiveScore(r) ?? 0);
      const passes = runs.filter((r) => effectiveVerdict(r) === "pass").length;
      const errCount = runs.filter((r) => r.error && !r.skipped).length;
      const skipCount = runs.filter((r) => r.skipped).length;
      const title = runs[0].title.length > 45 ? runs[0].title.slice(0, 42) + "..." : runs[0].title;
      if (scoredRuns.length === 0) {
        lines.push(`  [${String(idx).padStart(2)}] ${title}  💥 all runs errored/skipped (${errCount}E/${skipCount}S)`);
        continue;
      }
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const med = median(scores);
      const sd = stddev(scores);
      const allScores = scores.join("/");
      const errTag = (errCount + skipCount) > 0 ? ` ⚠️${errCount}E/${skipCount}S` : "";
      lines.push(
        `  [${String(idx).padStart(2)}] ${title}` +
        `  pass ${passes}/${runs.length}` +
        `  mean=${mean.toFixed(1)} med=${med.toFixed(1)} σ=${sd.toFixed(1)}` +
        `  scores=[${allScores}]${errTag}`,
      );
    }
  }

  lines.push("═".repeat(60));

  const passRate = scored > 0 ? ((passed / scored) * 100).toFixed(1) : "0.0";
  const passPartialRate = scored > 0 ? (((passed + partial) / scored) * 100).toFixed(1) : "0.0";
  lines.push(`  Pass Rate:          ${passRate}%${completedLabel}`);
  lines.push(`  Pass+Partial Rate:  ${passPartialRate}%${completedLabel}`);
  lines.push("═".repeat(60));

  return lines.join("\n");
}

/**
 * Print a summary of eval results to the console.
 */
export function printSummary(results: EvalRunResults): void {
  console.log(buildSummary(results));
}
