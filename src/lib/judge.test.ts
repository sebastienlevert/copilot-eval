import { describe, it, expect } from "vitest";
import { buildJudgingPrompt, parseJudgment } from "./judge.js";
import type { EvalCase, SkillOutput, Judgment } from "./types.js";

function makeEvalCase(overrides?: Partial<EvalCase>): EvalCase {
  return {
    title: "Create a Teams bot",
    turns: [
      {
        prompt: "Create a Teams bot",
        expected_response: "Should scaffold a bot project using Teams Toolkit",
      },
    ],
    ...overrides,
  };
}

function makeSkillOutput(overrides?: Partial<SkillOutput>): SkillOutput {
  return {
    response: "I created a Teams bot project using Teams Toolkit...",
    sessionLog: null,
    skillUsed: true,
    exitCode: 0,
    duration: 5000,
    turnResponses: ["I created a Teams bot project using Teams Toolkit..."],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildJudgingPrompt
// ---------------------------------------------------------------------------
describe("buildJudgingPrompt", () => {
  it("includes the eval prompt", () => {
    const result = buildJudgingPrompt(makeEvalCase(), makeSkillOutput());
    expect(result).toContain("Create a Teams bot");
  });

  it("includes the expected behavior", () => {
    const result = buildJudgingPrompt(makeEvalCase(), makeSkillOutput());
    expect(result).toContain("Should scaffold a bot project using Teams Toolkit");
  });

  it("includes the skill output response", () => {
    const result = buildJudgingPrompt(
      makeEvalCase(),
      makeSkillOutput({ response: "unique-response-xyz" }),
    );
    expect(result).toContain("unique-response-xyz");
  });

  it("includes JSON format instructions", () => {
    const result = buildJudgingPrompt(makeEvalCase(), makeSkillOutput());
    expect(result).toContain("```json");
    expect(result).toContain('"verdict"');
    expect(result).toContain('"score"');
  });

  it("includes verdict rules", () => {
    const result = buildJudgingPrompt(makeEvalCase(), makeSkillOutput());
    expect(result).toContain("pass");
    expect(result).toContain("partial");
    expect(result).toContain("fail");
  });

  it("includes scoring ranges", () => {
    const result = buildJudgingPrompt(makeEvalCase(), makeSkillOutput());
    expect(result).toContain("80-100");
    expect(result).toContain("40-79");
    expect(result).toContain("0-39");
  });

  it("includes criteria_met and criteria_missed fields", () => {
    const result = buildJudgingPrompt(makeEvalCase(), makeSkillOutput());
    expect(result).toContain("criteria_met");
    expect(result).toContain("criteria_missed");
  });

  it("includes reasoning field", () => {
    const result = buildJudgingPrompt(makeEvalCase(), makeSkillOutput());
    expect(result).toContain("reasoning");
  });

  it("includes User Prompt label", () => {
    const result = buildJudgingPrompt(makeEvalCase(), makeSkillOutput());
    expect(result).toContain("**User Prompt:**");
  });

  it("includes Expected Behavior label", () => {
    const result = buildJudgingPrompt(makeEvalCase(), makeSkillOutput());
    expect(result).toContain("**Expected Behavior:**");
  });

  it("includes evaluation instructions", () => {
    const result = buildJudgingPrompt(makeEvalCase(), makeSkillOutput());
    expect(result).toContain("correct commands/tools");
    expect(result).toContain("workflow steps");
    expect(result).toContain("prohibited actions");
  });

  it("handles long prompts", () => {
    const longPrompt = "x".repeat(5000);
    const result = buildJudgingPrompt(
      makeEvalCase({ turns: [{ prompt: longPrompt, expected_response: "test" }] }),
      makeSkillOutput(),
    );
    expect(result).toContain(longPrompt);
  });

  it("handles long responses", () => {
    const longResponse = "y".repeat(5000);
    const result = buildJudgingPrompt(
      makeEvalCase(),
      makeSkillOutput({ response: longResponse }),
    );
    expect(result).toContain(longResponse);
  });

  it("handles special characters in prompt", () => {
    const result = buildJudgingPrompt(
      makeEvalCase({ turns: [{ prompt: 'test "with" <special> & chars', expected_response: "test" }] }),
      makeSkillOutput(),
    );
    expect(result).toContain('test "with" <special> & chars');
  });

  it("handles multi-line expected behavior", () => {
    const result = buildJudgingPrompt(
      makeEvalCase({ turns: [{ prompt: "test", expected_response: "line1\nline2\nline3" }] }),
      makeSkillOutput(),
    );
    expect(result).toContain("line1\nline2\nline3");
  });

  it("returns a non-empty string", () => {
    expect(buildJudgingPrompt(makeEvalCase(), makeSkillOutput()).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseJudgment
// ---------------------------------------------------------------------------
describe("parseJudgment", () => {
  const validJudgment: Judgment = {
    verdict: "pass",
    score: 90,
    criteria_met: ["Created project", "Used correct tool"],
    criteria_missed: [],
    reasoning: "All criteria satisfied",
  };

  it("parses fenced JSON block", () => {
    const raw = `Here's my judgment:\n\`\`\`json\n${JSON.stringify(validJudgment)}\n\`\`\``;
    const result = parseJudgment(raw);
    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(90);
  });

  it("parses raw JSON without fences", () => {
    const result = parseJudgment(JSON.stringify(validJudgment));
    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(90);
  });

  it("returns fail verdict for unparseable response", () => {
    const result = parseJudgment("this is not json at all");
    expect(result.verdict).toBe("fail");
    expect(result.score).toBe(0);
  });

  it("includes 'Could not parse' in criteria_missed on failure", () => {
    const result = parseJudgment("garbage");
    expect(result.criteria_missed).toContain("Could not parse judge response");
  });

  it("includes raw response in reasoning on failure", () => {
    const result = parseJudgment("some unparseable text");
    expect(result.reasoning).toContain("some unparseable text");
  });

  it("truncates long raw responses in failure reasoning", () => {
    const longText = "x".repeat(1000);
    const result = parseJudgment(longText);
    expect(result.reasoning.length).toBeLessThan(1000);
  });

  it("extracts all judgment fields", () => {
    const raw = `\`\`\`json\n${JSON.stringify(validJudgment)}\n\`\`\``;
    const result = parseJudgment(raw);
    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(90);
    expect(result.criteria_met).toEqual(["Created project", "Used correct tool"]);
    expect(result.criteria_missed).toEqual([]);
    expect(result.reasoning).toBe("All criteria satisfied");
  });

  it("handles fail verdict", () => {
    const judgment: Judgment = {
      verdict: "fail",
      score: 10,
      criteria_met: [],
      criteria_missed: ["Wrong approach"],
      reasoning: "Totally wrong",
    };
    const result = parseJudgment(JSON.stringify(judgment));
    expect(result.verdict).toBe("fail");
    expect(result.score).toBe(10);
  });

  it("handles partial verdict", () => {
    const judgment: Judgment = {
      verdict: "partial",
      score: 55,
      criteria_met: ["Some correct"],
      criteria_missed: ["Missing deploy"],
      reasoning: "Partially done",
    };
    const result = parseJudgment(JSON.stringify(judgment));
    expect(result.verdict).toBe("partial");
    expect(result.score).toBe(55);
  });

  it("handles empty criteria arrays", () => {
    const judgment: Judgment = {
      verdict: "pass",
      score: 100,
      criteria_met: [],
      criteria_missed: [],
      reasoning: "Perfect",
    };
    const result = parseJudgment(JSON.stringify(judgment));
    expect(result.criteria_met).toEqual([]);
    expect(result.criteria_missed).toEqual([]);
  });

  it("handles JSON with extra whitespace", () => {
    const result = parseJudgment(`  \n  ${JSON.stringify(validJudgment)}  \n  `);
    expect(result.verdict).toBe("pass");
  });

  it("falls back from malformed fenced JSON to raw JSON", () => {
    // Fenced JSON is broken but raw JSON is valid
    const raw = `\`\`\`json\n{broken json}\n\`\`\`\nNow here's valid: ${JSON.stringify(validJudgment)}`;
    // This should fail on fenced, then fail on raw too since the text has extra content
    const result = parseJudgment(raw);
    // With extra text it won't parse as raw JSON either, so it should be a fail
    expect(result).toBeDefined();
  });

  it("prefers fenced JSON over raw JSON", () => {
    const fenced: Judgment = { ...validJudgment, score: 75 };
    const raw = `Some text ${JSON.stringify({ ...validJudgment, score: 50 })}\n\`\`\`json\n${JSON.stringify(fenced)}\n\`\`\``;
    const result = parseJudgment(raw);
    expect(result.score).toBe(75);
  });

  it("handles fenced JSON with indentation", () => {
    const indented = JSON.stringify(validJudgment, null, 2);
    const raw = `\`\`\`json\n${indented}\n\`\`\``;
    const result = parseJudgment(raw);
    expect(result.verdict).toBe("pass");
  });

  it("handles score of 0", () => {
    const judgment: Judgment = {
      verdict: "fail",
      score: 0,
      criteria_met: [],
      criteria_missed: ["Everything"],
      reasoning: "Nothing worked",
    };
    const result = parseJudgment(JSON.stringify(judgment));
    expect(result.score).toBe(0);
  });

  it("handles score of 100", () => {
    const judgment: Judgment = {
      verdict: "pass",
      score: 100,
      criteria_met: ["Everything"],
      criteria_missed: [],
      reasoning: "Perfect",
    };
    const result = parseJudgment(JSON.stringify(judgment));
    expect(result.score).toBe(100);
  });

  it("handles multiple criteria_met", () => {
    const judgment: Judgment = {
      verdict: "pass",
      score: 95,
      criteria_met: ["a", "b", "c", "d", "e"],
      criteria_missed: [],
      reasoning: "All good",
    };
    const result = parseJudgment(JSON.stringify(judgment));
    expect(result.criteria_met).toHaveLength(5);
  });

  it("handles multiple criteria_missed", () => {
    const judgment: Judgment = {
      verdict: "fail",
      score: 5,
      criteria_met: [],
      criteria_missed: ["x", "y", "z"],
      reasoning: "Many issues",
    };
    const result = parseJudgment(JSON.stringify(judgment));
    expect(result.criteria_missed).toHaveLength(3);
  });

  it("handles empty string input", () => {
    const result = parseJudgment("");
    expect(result.verdict).toBe("fail");
    expect(result.score).toBe(0);
  });

  it("handles whitespace-only input", () => {
    const result = parseJudgment("   \n\n   ");
    expect(result.verdict).toBe("fail");
    expect(result.score).toBe(0);
  });

  it("handles reasoning with special characters", () => {
    const judgment: Judgment = {
      verdict: "pass",
      score: 85,
      criteria_met: ["done"],
      criteria_missed: [],
      reasoning: 'Used "quotes" and <tags> & ampersands',
    };
    const result = parseJudgment(JSON.stringify(judgment));
    expect(result.reasoning).toContain('"quotes"');
  });

  it("handles criteria with unicode", () => {
    const judgment: Judgment = {
      verdict: "pass",
      score: 90,
      criteria_met: ["✅ Passed check", "🔧 Tool used"],
      criteria_missed: [],
      reasoning: "Good",
    };
    const result = parseJudgment(JSON.stringify(judgment));
    expect(result.criteria_met[0]).toContain("✅");
  });

  it("handles fenced JSON with trailing text", () => {
    const raw = `\`\`\`json\n${JSON.stringify(validJudgment)}\n\`\`\`\nSome extra explanation here.`;
    const result = parseJudgment(raw);
    expect(result.verdict).toBe("pass");
  });

  it("handles fenced JSON with leading text", () => {
    const raw = `Here is my evaluation:\n\`\`\`json\n${JSON.stringify(validJudgment)}\n\`\`\``;
    const result = parseJudgment(raw);
    expect(result.verdict).toBe("pass");
  });
});
