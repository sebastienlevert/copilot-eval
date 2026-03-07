import { runCommand } from "./workspace.js";
import type { EvalCase, Judgment, SkillOutput } from "./types.js";

/**
 * Judge whether a skill's output satisfies the expected behavior.
 *
 * Uses the Copilot CLI itself as the judge — sends a structured
 * judging prompt and parses the verdict from the response.
 */
export async function judgeEval(
  evalCase: EvalCase,
  skillOutput: SkillOutput,
  model?: string,
): Promise<Judgment> {
  const judgingPrompt = buildJudgingPrompt(evalCase, skillOutput);

  const args = ["--yolo", "--experimental"];
  if (model) args.push("--model", model);

  const result = await runCommand(
    "copilot",
    args,
    { timeout: 300_000, input: judgingPrompt },
  );

  const raw = result.stdout + result.stderr;
  return parseJudgment(raw);
}

export function buildJudgingPrompt(evalCase: EvalCase, skillOutput: SkillOutput): string {
  const turns = evalCase.turns;
  const isMultiTurn = turns.length > 1;

  let evalSection: string;
  if (isMultiTurn) {
    evalSection = turns.map((t, i) =>
      `### Turn ${i + 1}\n\n**User Prompt:** ${t.prompt}\n\n**Expected Behavior:** ${t.expected}`
    ).join("\n\n");
  } else {
    evalSection = `**User Prompt:** ${turns[0].prompt}\n\n**Expected Behavior:** ${turns[0].expected}`;
  }

  let outputSection: string;
  if (isMultiTurn && skillOutput.turnResponses.length > 0) {
    outputSection = skillOutput.turnResponses.map((r, i) =>
      `### Turn ${i + 1} Response\n\n${r}`
    ).join("\n\n");
  } else {
    outputSection = skillOutput.response;
  }

  return `You are an eval judge for a Copilot CLI skill. Your job is to determine whether the skill's actual output satisfies the expected behavior.

## Eval Case${isMultiTurn ? " (Multi-Turn)" : ""}

${evalSection}

## Actual Skill Output

${outputSection}

## Instructions

Evaluate whether the actual output satisfies ALL criteria described in the expected behavior${isMultiTurn ? " across all turns" : ""}. Consider:
1. Did it use the correct commands/tools?
2. Did it follow the required workflow steps?
3. Did it avoid prohibited actions?
4. Did it include all required elements (validation, deployment, etc.)?${isMultiTurn ? "\n5. Did each turn's response satisfy its specific expected behavior?" : ""}

Respond with EXACTLY this JSON format and nothing else:

\`\`\`json
{
  "verdict": "pass" | "fail" | "partial",
  "score": <number 0-100>,
  "criteria_met": ["list of criteria that were satisfied"],
  "criteria_missed": ["list of criteria that were NOT satisfied"],
  "reasoning": "Brief explanation of your judgment"
}
\`\`\`

Rules:
- "pass" (score 80-100): All key criteria met
- "partial" (score 40-79): Some criteria met but important ones missing
- "fail" (score 0-39): Key criteria not met or wrong approach taken`;
}

export function parseJudgment(raw: string): Judgment {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      // Fall through to fallback
    }
  }

  try {
    return JSON.parse(raw.trim());
  } catch {
    return {
      verdict: "fail",
      score: 0,
      criteria_met: [],
      criteria_missed: ["Could not parse judge response"],
      reasoning: `Judge returned unparseable response: ${raw.slice(0, 500)}`,
    };
  }
}
