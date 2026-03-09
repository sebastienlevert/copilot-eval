import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printSummary } from "./reporter.js";
import type { EvalRunResults, EvalResult, Judgment } from "./types.js";

function makeJudgment(overrides?: Partial<Judgment>): Judgment {
  return {
    verdict: "pass",
    score: 90,
    criteria_met: ["done"],
    criteria_missed: [],
    reasoning: "ok",
    ...overrides,
  };
}

function makeEvalResult(overrides?: Partial<EvalResult>): EvalResult {
  return {
    index: 0,
    title: "test eval",
    turns: [{ prompt: "test prompt", expected_response: "test expected" }],
    duration: 1000,
    judgment: makeJudgment(),
    ...overrides,
  };
}

function makeResults(overrides?: Partial<EvalRunResults>): EvalRunResults {
  return {
    skill: "test-skill",
    timestamp: "2026-01-01T00:00:00.000Z",
    totalDuration: 5000,
    evalCount: 1,
    evals: [makeEvalResult()],
    ...overrides,
  };
}

let consoleOutput: string[];
const originalLog = console.log;

beforeEach(() => {
  consoleOutput = [];
  console.log = vi.fn((...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  console.log = originalLog;
});

function allOutput(): string {
  return consoleOutput.join("\n");
}

// ---------------------------------------------------------------------------
// printSummary
// ---------------------------------------------------------------------------
describe("printSummary", () => {
  it("prints skill name", () => {
    printSummary(makeResults({ skill: "my-awesome-skill" }));
    expect(allOutput()).toContain("my-awesome-skill");
  });

  it("prints timestamp", () => {
    printSummary(makeResults({ timestamp: "2026-03-15T12:00:00Z" }));
    expect(allOutput()).toContain("2026-03-15T12:00:00Z");
  });

  it("prints total duration in seconds", () => {
    printSummary(makeResults({ totalDuration: 12345 }));
    expect(allOutput()).toContain("12.3s");
  });

  it("prints Pass count", () => {
    printSummary(makeResults({
      evals: [
        makeEvalResult({ judgment: makeJudgment({ verdict: "pass" }) }),
        makeEvalResult({ judgment: makeJudgment({ verdict: "pass" }) }),
      ],
    }));
    expect(allOutput()).toContain("Pass: 2");
  });

  it("prints Partial count", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ judgment: makeJudgment({ verdict: "partial" }) })],
    }));
    expect(allOutput()).toContain("Partial: 1");
  });

  it("prints Fail count", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ judgment: makeJudgment({ verdict: "fail" }) })],
    }));
    expect(allOutput()).toContain("Fail: 1");
  });

  it("prints Error count", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ error: "boom", judgment: null })],
    }));
    expect(allOutput()).toContain("Error: 1");
  });

  it("prints average score", () => {
    printSummary(makeResults({
      evals: [
        makeEvalResult({ judgment: makeJudgment({ score: 80 }) }),
        makeEvalResult({ judgment: makeJudgment({ score: 60 }) }),
      ],
    }));
    expect(allOutput()).toContain("70.0/100");
  });

  it("prints pass rate as percentage", () => {
    printSummary(makeResults({
      evals: [
        makeEvalResult({ judgment: makeJudgment({ verdict: "pass" }) }),
        makeEvalResult({ judgment: makeJudgment({ verdict: "fail" }) }),
      ],
    }));
    expect(allOutput()).toContain("50.0%");
  });

  it("prints pass+partial rate", () => {
    printSummary(makeResults({
      evals: [
        makeEvalResult({ judgment: makeJudgment({ verdict: "pass" }) }),
        makeEvalResult({ judgment: makeJudgment({ verdict: "partial" }) }),
        makeEvalResult({ judgment: makeJudgment({ verdict: "fail" }) }),
      ],
    }));
    // 2/3 = 66.7%
    expect(allOutput()).toContain("66.7%");
  });

  it("prints ✅ icon for pass", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ judgment: makeJudgment({ verdict: "pass" }) })],
    }));
    expect(allOutput()).toContain("✅");
  });

  it("prints 🟡 icon for partial", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ judgment: makeJudgment({ verdict: "partial" }) })],
    }));
    expect(allOutput()).toContain("🟡");
  });

  it("prints ❌ icon for fail", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ judgment: makeJudgment({ verdict: "fail" }) })],
    }));
    expect(allOutput()).toContain("❌");
  });

  it("prints 💥 icon for errors", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ error: "oops", judgment: null })],
    }));
    expect(allOutput()).toContain("💥");
  });

  it("prints individual eval scores", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ judgment: makeJudgment({ score: 85 }) })],
    }));
    expect(allOutput()).toContain("85");
  });

  it("prints eval title text", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ title: "create a bot project" })],
    }));
    expect(allOutput()).toContain("create a bot project");
  });

  it("truncates long titles to 50 chars", () => {
    const longTitle = "a".repeat(100);
    printSummary(makeResults({
      evals: [makeEvalResult({ title: longTitle })],
    }));
    const output = allOutput();
    expect(output).toContain("...");
    expect(output).not.toContain(longTitle);
  });

  it("prints missed criteria", () => {
    printSummary(makeResults({
      evals: [
        makeEvalResult({
          judgment: makeJudgment({
            verdict: "fail",
            criteria_missed: ["Missing validation step"],
          }),
        }),
      ],
    }));
    expect(allOutput()).toContain("Missing validation step");
  });

  it("prints error messages", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ error: "spawn ENOENT", judgment: null })],
    }));
    expect(allOutput()).toContain("spawn ENOENT");
  });

  it("prints duration per eval", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ duration: 3456 })],
    }));
    expect(allOutput()).toContain("3.5s");
  });

  it("prints N/A for zero duration", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ duration: 0, error: "fail", judgment: null })],
    }));
    expect(allOutput()).toContain("N/A");
  });

  it("prints separator lines", () => {
    printSummary(makeResults());
    expect(allOutput()).toContain("═");
    expect(allOutput()).toContain("─");
  });

  it("prints SKILL EVAL RESULTS header", () => {
    printSummary(makeResults());
    expect(allOutput()).toContain("SKILL EVAL RESULTS");
  });

  it("handles multiple evals with mixed verdicts", () => {
    printSummary(makeResults({
      evals: [
        makeEvalResult({ index: 0, judgment: makeJudgment({ verdict: "pass", score: 90 }) }),
        makeEvalResult({ index: 1, judgment: makeJudgment({ verdict: "partial", score: 60 }) }),
        makeEvalResult({ index: 2, judgment: makeJudgment({ verdict: "fail", score: 20 }) }),
        makeEvalResult({ index: 3, error: "timeout", judgment: null }),
      ],
    }));
    const output = allOutput();
    expect(output).toContain("Total: 4");
    expect(output).toContain("Pass: 1");
    expect(output).toContain("Partial: 1");
    expect(output).toContain("Fail: 1");
    expect(output).toContain("Error: 1");
  });

  it("prints multiple missed criteria on separate lines", () => {
    printSummary(makeResults({
      evals: [
        makeEvalResult({
          judgment: makeJudgment({
            verdict: "fail",
            criteria_missed: ["Missing A", "Missing B", "Missing C"],
          }),
        }),
      ],
    }));
    const output = allOutput();
    expect(output).toContain("Missing A");
    expect(output).toContain("Missing B");
    expect(output).toContain("Missing C");
  });

  it("handles 100% pass rate", () => {
    printSummary(makeResults({
      evals: [
        makeEvalResult({ judgment: makeJudgment({ verdict: "pass" }) }),
        makeEvalResult({ judgment: makeJudgment({ verdict: "pass" }) }),
      ],
    }));
    expect(allOutput()).toContain("100.0%");
  });

  it("handles 0% pass rate", () => {
    printSummary(makeResults({
      evals: [
        makeEvalResult({ judgment: makeJudgment({ verdict: "fail" }) }),
        makeEvalResult({ judgment: makeJudgment({ verdict: "fail" }) }),
      ],
    }));
    expect(allOutput()).toContain("0.0%");
  });

  it("handles single eval", () => {
    printSummary(makeResults({
      evals: [makeEvalResult()],
    }));
    expect(allOutput()).toContain("Total: 1");
  });

  it("shows ERR for score when no judgment", () => {
    printSummary(makeResults({
      evals: [makeEvalResult({ judgment: null, error: "fail" })],
    }));
    expect(allOutput()).toContain("ERR");
  });
});
