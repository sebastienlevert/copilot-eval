import { readdir, stat, readFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { runCommand } from "./workspace.js";
import type { EvalTurn, SkillOutput } from "./types.js";

const COPILOT_LOGS_DIR = join(homedir(), ".copilot", "logs");

/**
 * Detect if the Copilot CLI response indicates rate limiting / throttling.
 */
export function isThrottled(response: string): boolean {
  const text = response.toLowerCase();
  if (/rate.?limit/i.test(text)) return true;
  if (/throttl/i.test(text)) return true;
  if (/\b429\b/.test(text)) return true;
  if (/too many requests/i.test(text)) return true;
  return false;
}

/**
 * Check if a skill was invoked by looking for skill usage in the logs.
 * Matches both response format `skill(name)` and session log JSON format.
 */
export function detectSkillUsage(sessionLog: string | null, response: string): boolean {
  const text = (sessionLog || "") + response;
  // Response format: skill(m365-agent-developer)
  if (/skill\(.+\)/i.test(text)) return true;
  // Session log JSON: "name": "skill"
  if (/"name":\s*"skill"/.test(text)) return true;
  return false;
}

/**
 * Find a process log file by the PID of the copilot process.
 * Log files are named process-{timestamp}-{pid}.log.
 * Falls back to latest-by-mtime if no PID match is found.
 */
async function findProcessLog(pid?: number, afterMs?: number): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(COPILOT_LOGS_DIR);
  } catch {
    return null;
  }
  const processLogs = files.filter(
    (f) => f.startsWith("process-") && f.endsWith(".log"),
  );

  // Primary: match by PID (exact match on the suffix before .log)
  if (pid) {
    const pidSuffix = `-${pid}.log`;
    const match = processLogs.find((f) => f.endsWith(pidSuffix));
    if (match) return join(COPILOT_LOGS_DIR, match);
  }

  // Fallback: latest by mtime (for backward compat / single-concurrency)
  if (afterMs) {
    let latest: string | null = null;
    let latestMtime = 0;
    for (const file of processLogs) {
      const filePath = join(COPILOT_LOGS_DIR, file);
      const s = await stat(filePath);
      if (s.mtimeMs > afterMs && s.mtimeMs > latestMtime) {
        latest = filePath;
        latestMtime = s.mtimeMs;
      }
    }
    return latest;
  }

  return null;
}

/**
 * Execute an eval against the skill using the Copilot CLI.
 *
 * For single-turn evals, pipes the prompt via stdin and closes it.
 * For multi-turn evals, sends prompts interactively, waiting for
 * output quiescence between turns.
 */
export async function executeEval(
  turns: EvalTurn[],
  workspaceDir: string,
  runDir: string,
  evalId: string,
  model?: string,
  onTurnComplete?: (turnIdx: number) => void,
): Promise<SkillOutput> {
  const start = Date.now();
  const beforeExec = Date.now();

  const baseArgs = ["--yolo", "--experimental"];
  if (model) baseArgs.push("--model", model);

  const prompts = turns.map((t) => t.prompt);
  const turnResponses: string[] = [];
  let fullResponse = "";
  let lastExitCode: number | null = null;
  let copilotSessionId: string | null = null;

  for (let i = 0; i < prompts.length; i++) {
    const args = [...baseArgs, "-p", prompts[i]];
    if (i > 0 && copilotSessionId) {
      args.push("--resume", copilotSessionId);
    }

    const result = await runCommand("copilot", args, {
      cwd: workspaceDir,
      timeout: 900_000,
    });

    const turnResponse = result.stdout + result.stderr;
    const cmdLine = `$ copilot ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`;
    const header = `\n--- Turn ${i + 1}/${prompts.length} ---\n${cmdLine}\n\n`;
    turnResponses.push(turnResponse);
    fullResponse += header + turnResponse + "\n";
    lastExitCode = result.code;

    // Extract session ID from process log after the first turn (use PID for accuracy)
    if (i === 0) {
      const logPath = await findProcessLog(result.pid, beforeExec);
      if (logPath) {
        const logContent = await readFile(logPath, "utf-8");
        const match = logContent.match(/"session_id":\s*"([a-f0-9-]+)"/);
        if (match) copilotSessionId = match[1];
      }
    }

    if (onTurnComplete) onTurnComplete(i);
  }

  // Find and read the Copilot process log (use last turn's PID, fall back to mtime)
  let sessionLog: string | null = null;
  const processLogPath = await findProcessLog(undefined, beforeExec);
  if (processLogPath) {
    sessionLog = await readFile(processLogPath, "utf-8");
  }

  // Save logs to the run's logs/ directory
  const logsDir = join(runDir, "logs");
  await mkdir(logsDir, { recursive: true });
  await writeFile(join(logsDir, `${evalId}-response.log`), fullResponse);

  if (processLogPath) {
    await copyFile(processLogPath, join(logsDir, `${evalId}-session.log`));
  }

  const duration = Date.now() - start;

  return { response: fullResponse, sessionLog, skillUsed: detectSkillUsage(sessionLog, fullResponse), exitCode: lastExitCode, duration, turnResponses };
}
