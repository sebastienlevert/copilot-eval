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

  // Judge needs no tools — it only evaluates text.
  // Without these flags, all MCP servers / plugins load and can exceed the
  // API's 128-tool limit, causing "could not parse judge response" failures.
  const args = [
    "--yolo",
    "--experimental",
    "--available-tools=",       // no tools at all
    "--disable-builtin-mcps",   // skip GitHub MCP server
    "--no-custom-instructions", // skip project instructions
  ];
  if (model) args.push("--model", model);

  const maxAttempts = 3;
  let lastRaw = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runCommand(
      "copilot",
      args,
      { timeout: 300_000, input: judgingPrompt },
    );
    const raw = result.stdout + result.stderr;
    lastRaw = raw;
    const judgment = parseJudgment(raw);
    const looksUnparseable =
      judgment.criteria_missed?.[0] === "Could not parse judge response" ||
      /transient API error/i.test(raw);
    if (!looksUnparseable || attempt === maxAttempts) {
      return judgment;
    }
    // Retry on transient API error / unparseable response
  }
  return parseJudgment(lastRaw);
}

export function buildJudgingPrompt(evalCase: EvalCase, skillOutput: SkillOutput): string {
  const turns = evalCase.turns;
  const isMultiTurn = turns.length > 1;

  let evalSection: string;
  if (isMultiTurn) {
    evalSection = turns.map((t, i) =>
      `### Turn ${i + 1}\n\n**User Prompt:** ${t.prompt}\n\n**Expected Behavior:** ${t.expected_response}`
    ).join("\n\n");
  } else {
    evalSection = `**User Prompt:** ${turns[0].prompt}\n\n**Expected Behavior:** ${turns[0].expected_response}`;
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

### Important judging guidance

- **Skill invocation evidence:** A skill is considered invoked if you see ANY of:
  (a) an explicit \`skill(<name>)\` call in the output,
  (b) the agent stating it is using or running the skill (e.g., "running agent-create", "using the agent-edit skill"),
  (c) the documented workflow steps for that skill being executed (behavioral evidence).
  Do NOT mark a skill-invocation criterion as missed solely because the literal \`skill(name)\` log marker is absent.

- **Stopped-due-to-prerequisite is NOT a failure.** When a criterion contains an OR clause (e.g., "Either runs X AND reports Y, OR — if not provisioned — clearly reports prerequisites are missing"), credit it as MET if either branch is satisfied. Refusing to act when prerequisites are missing (unprovisioned agent, invalid GUID, missing files, unreachable external server, missing secrets) AND clearly explaining what's needed is correct, safe behavior.

- **External failures don't penalize the agent.** When a tool call fails due to an unreachable URL, network error, missing backend resource, or transient API error, do NOT count that as a missed criterion if the agent (i) attempted the correct call and (ii) reported the failure clearly. The agent only controls the attempt, not the backend's availability.

- **Negative criteria ("Does not modify X"):** Only count as missed if there is positive evidence the agent DID modify X. Absence of mention is NOT evidence of modification.${isMultiTurn ? `

- **Turn attribution (REQUIRED for multi-turn):** Every criterion in \`criteria_met\` and \`criteria_missed\` MUST start with the prefix \`Turn N: \` (e.g., \`Turn 1: Invokes the agent-create skill\`, \`Turn 3: Updates declarativeAgent.json\`) where N is the turn the criterion applies to. Use this prefix even for criteria that span multiple turns — pick the turn where the behavior should first occur. Only criteria that are genuinely overall/cross-cutting (with no specific turn) may omit the prefix.` : ""}

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
  // Try every ```json ... ``` block (last-to-first), in case an earlier one
  // was truncated by a transient API error and a retry produced a clean one.
  const blocks = Array.from(raw.matchAll(/```json\s*([\s\S]*?)\s*```/g));
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(blocks[i][1]);
    } catch {
      // Try the next one
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
