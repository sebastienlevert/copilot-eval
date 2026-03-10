import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { CommandResult, EvalCase, EvalsFile, EvalRunResults, RunCommandOptions } from "./types.js";

export interface InteractiveResult {
  code: number | null;
  stdout: string;
  stderr: string;
  turnOutputs: string[];
}


import { randomUUID } from "node:crypto";

/**
 * Create an empty workspace directory for an eval run.
 * Creates a GUID-named directory inside baseDir (or system temp).
 * Returns { dir, id } where id is the GUID.
 */
export async function createWorkspace(baseDir?: string): Promise<{ dir: string; id: string }> {
  if (baseDir) {
    await mkdir(baseDir, { recursive: true });
  }
  const parent = baseDir || tmpdir();
  const id = randomUUID();
  const dir = join(parent, id);
  await mkdir(dir, { recursive: true });
  // Sentinel prevents git from traversing up to the repo root
  await writeFile(join(dir, ".git"), "");
  return { dir, id };
}

/**
 * Run a command and capture output with a timeout.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const { timeout = 120_000, cwd, input, env } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : undefined,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
        }, timeout)
      : null;

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    }

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({ code: code ?? 1, stdout, stderr: stderr + "\n[TIMED OUT]", pid: proc.pid });
      } else {
        resolve({ code, stdout, stderr, pid: proc.pid });
      }
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run a command interactively, sending multiple prompts sequentially.
 * Waits for output quiescence (no new output for IDLE_MS) before
 * sending the next prompt. Returns per-turn captured output.
 */
export function runInteractiveCommand(
  command: string,
  args: string[],
  prompts: string[],
  options: RunCommandOptions = {},
): Promise<InteractiveResult> {
  const { timeout = 900_000, cwd } = options;
  const IDLE_MS = 10_000;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let fullStdout = "";
    let fullStderr = "";
    let turnOutput = "";
    const turnOutputs: string[] = [];
    let currentTurn = 0;
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let seenOutputThisTurn = false;

    const globalTimer = timeout
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
        }, timeout)
      : null;

    function sendNextTurn() {
      turnOutputs.push(turnOutput);
      turnOutput = "";
      seenOutputThisTurn = false;
      currentTurn++;
      if (currentTurn < prompts.length) {
        proc.stdin.write(prompts[currentTurn] + "\n");
      } else {
        proc.stdin.end();
      }
    }

    function resetIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      if (seenOutputThisTurn) {
        idleTimer = setTimeout(sendNextTurn, IDLE_MS);
      }
    }

    proc.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      fullStdout += chunk;
      turnOutput += chunk;
      seenOutputThisTurn = true;
      resetIdle();
    });

    proc.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      fullStderr += chunk;
      turnOutput += chunk;
      seenOutputThisTurn = true;
      resetIdle();
    });

    // Send first prompt
    proc.stdin.write(prompts[0] + "\n");

    proc.on("close", (code) => {
      if (globalTimer) clearTimeout(globalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (turnOutput) turnOutputs.push(turnOutput);
      resolve({
        code: timedOut ? (code ?? 1) : code,
        stdout: fullStdout,
        stderr: timedOut ? fullStderr + "\n[TIMED OUT]" : fullStderr,
        turnOutputs,
      });
    });

    proc.on("error", (err) => {
      if (globalTimer) clearTimeout(globalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      reject(err);
    });
  });
}

/**
 * Load evals from a project directory.
 * Supports evals.yaml (preferred), evals.yml, and evals.json (legacy fallback).
 * Supports both the new object format ({ evals: [...] }) and the legacy bare-array format.
 */
export async function loadEvals(skillDir: string): Promise<EvalsFile> {
  const yamlPath = join(skillDir, "evals.yaml");
  const ymlPath = join(skillDir, "evals.yml");
  const jsonPath = join(skillDir, "evals.json");

  let raw: string;
  let isYaml: boolean;

  if (existsSync(yamlPath)) {
    raw = await readFile(yamlPath, "utf-8");
    isYaml = true;
  } else if (existsSync(ymlPath)) {
    raw = await readFile(ymlPath, "utf-8");
    isYaml = true;
  } else if (existsSync(jsonPath)) {
    raw = await readFile(jsonPath, "utf-8");
    isYaml = false;
  } else {
    throw new Error(`No evals.yaml (or evals.yml / evals.json) found at ${skillDir}`);
  }

  const parsed = isYaml ? parseYaml(raw) : JSON.parse(raw);

  // Backward-compatible: bare array → wrap into EvalsFile
  if (Array.isArray(parsed)) {
    return { evals: parsed };
  }
  return parsed as EvalsFile;
}

/**
 * Variables available for placeholder resolution in setup/teardown scripts.
 * Use {{variableName}} syntax in script strings (e.g., "echo {{runId}}").
 * Also exposed as COPILOT_EVAL_* environment variables to the script process.
 */
export interface ScriptVariables {
  /** Run tag, e.g. "2026-02-26-001" */
  runId?: string;
  /** Absolute path to the run directory */
  runDir?: string;
  /** Absolute path to the project directory */
  projectDir?: string;
  /** Workspace UUID (per-eval only) */
  workspaceId?: string;
  /** Absolute path to the workspace directory (per-eval only). Also available as {{workspacePath}}. */
  workspaceDir?: string;
}

/**
 * Replace {{placeholder}} tokens in a string with values from the variables map.
 */
export function resolvePlaceholders(template: string, vars: ScriptVariables): string {
  // Build a flat lookup that includes aliases (e.g. workspacePath → workspaceDir)
  const lookup: Record<string, string | undefined> = { ...vars };
  if (vars.workspaceDir) lookup.workspacePath = vars.workspaceDir;

  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = lookup[key];
    return value !== undefined ? value : match;
  });
}

/**
 * Run a shell command defined in evals.yml scripts.
 * Resolves placeholders and exposes variables as COPILOT_EVAL_* env vars.
 * Runs in the specified cwd. Throws on non-zero exit.
 */
export async function runScript(
  command: string,
  cwd: string,
  vars: ScriptVariables = {},
): Promise<CommandResult> {
  const resolved = resolvePlaceholders(command, vars);

  // Expose variables as COPILOT_EVAL_* environment variables
  const env: Record<string, string> = {};
  if (vars.runId) env.COPILOT_EVAL_RUN_ID = vars.runId;
  if (vars.runDir) env.COPILOT_EVAL_RUN_DIR = vars.runDir;
  if (vars.projectDir) env.COPILOT_EVAL_PROJECT_DIR = vars.projectDir;
  if (vars.workspaceId) env.COPILOT_EVAL_WORKSPACE_ID = vars.workspaceId;
  if (vars.workspaceDir) env.COPILOT_EVAL_WORKSPACE_DIR = vars.workspaceDir;

  const result = await runCommand("sh", ["-c", resolved], {
    cwd,
    timeout: 300_000,
    env,
  });
  if (result.code !== 0) {
    throw new Error(
      `Script failed (exit ${result.code}): ${resolved}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

/**
 * Save results to a directory.
 */
export async function saveResults(
  outputDir: string,
  results: EvalRunResults,
  filename: string,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, filename);
  await writeFile(filePath, JSON.stringify(results, null, 2));
  return filePath;
}
