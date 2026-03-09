export interface EvalTurn {
  prompt: string;
  expected_response: string;
}

export interface EvalScripts {
  /** Shell command to run before (global: before all evals, per-eval: before this eval) */
  setup?: string;
  /** Shell command to run after (global: after all evals, per-eval: after this eval) */
  teardown?: string;
  /** Default shell command to run before each eval (overridden by per-eval scripts.setup) */
  "setup:eval"?: string;
  /** Default shell command to run after each eval (overridden by per-eval scripts.teardown) */
  "teardown:eval"?: string;
}

export interface EvalCase {
  title: string;
  turns: EvalTurn[];
  category?: string;
  /** Setup/teardown shell commands for this eval */
  scripts?: EvalScripts;
}

/**
 * Top-level structure of evals.yml.
 * Supports both the new object format and legacy bare-array format.
 */
export interface EvalsFile {
  $schema?: string;
  /** Global setup/teardown shell commands (run once before/after all evals) */
  scripts?: EvalScripts;
  evals: EvalCase[];
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  pid?: number;
}

export interface RunCommandOptions {
  timeout?: number;
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
}

export interface SkillOutput {
  response: string;
  sessionLog: string | null;
  skillUsed: boolean;
  exitCode: number | null;
  duration: number;
  turnResponses: string[];
}

export interface Judgment {
  verdict: "pass" | "fail" | "partial";
  score: number;
  criteria_met: string[];
  criteria_missed: string[];
  reasoning: string;
}

export interface EvalResult {
  index: number;
  sessionId?: string;
  title: string;
  turns: EvalTurn[];
  category?: string;
  response?: string;
  turnResponses?: string[];
  exitCode?: number | null;
  duration: number;
  skillUsed?: boolean;
  judgment: Judgment | null;
  error?: string;
}

export interface EvalRunResults {
  skill: string;
  timestamp: string;
  totalDuration: number;
  evalCount: number;
  evals: EvalResult[];
}
