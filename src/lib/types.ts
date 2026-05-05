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
  /** Optional variance tag for audience-specific evals (e.g., "1p", "3p").
   *  When set, this eval only runs when the matching `--variance` flag is
   *  passed. Evals without a variance field always run regardless. */
  variance?: string;
  /** Setup/teardown shell commands for this eval */
  scripts?: EvalScripts;
  /** Deterministic assertions evaluated alongside the LLM judge.
   *  When present, the final score is a weighted combination of
   *  assertion pass-rate and the judge score. */
  assertions?: Assertion[];
  /** Optional custom agent to run this eval within (e.g. "agent-coach").
   *  Overrides the run-level `--agent` flag. When omitted, the run-level
   *  default applies; when both are omitted, evals run against the default
   *  Copilot CLI experience. Useful for A/B-testing the same prompt with
   *  and without an orchestrator agent loaded. */
  agent?: string;
}

/**
 * Deterministic assertion types evaluated against workspace state and the
 * agent transcript. Each assertion produces a boolean pass/fail; together
 * they form a deterministic score that is combined with the LLM judge.
 *
 * Phase 1: file_exists, file_not_exists, file_contains, json_path,
 *          transcript_matches, transcript_not_matches, skill_invoked
 * Phase 2: file_unchanged, file_changed, cli_exit_zero
 * Phase 3: file_diff (against a golden master)
 */
export type Assertion =
  | { type: "file_exists"; path: string; description?: string }
  | { type: "file_not_exists"; path: string; description?: string }
  | { type: "file_glob_exists"; glob: string; minMatches?: number; description?: string }
  | { type: "file_contains"; path: string; pattern: string; flags?: string; description?: string }
  | { type: "json_path"; path: string; jsonPath: string; matches?: string; equals?: unknown; exists?: boolean; description?: string }
  | { type: "transcript_matches"; pattern: string; flags?: string; description?: string }
  | { type: "transcript_not_matches"; pattern: string; flags?: string; description?: string }
  | { type: "skill_invoked"; skill: string; description?: string }
  | { type: "file_unchanged"; path: string; description?: string }
  | { type: "file_changed"; path: string; description?: string }
  | { type: "cli_exit_zero"; command: string; cwd?: string; description?: string }
  | { type: "file_diff"; path: string; golden: string; description?: string };

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  reason: string;
}

export interface AssertionResults {
  results: AssertionResult[];
  passed: number;
  failed: number;
  total: number;
  /** Score from 0-100 representing pass rate; null when no assertions defined. */
  score: number | null;
}

/**
 * Top-level structure of evals.yaml.
 * Supports both the new object format and legacy bare-array format.
 */
export interface EvalsFile {
  $schema?: string;
  /** Global setup/teardown shell commands (run once before/after all evals) */
  scripts?: EvalScripts;
  /** Plugin/skill folder names to include in an isolated config dir.
   *  When set, only these plugins are available during the run.
   *  Names are resolved recursively from ~/.copilot/. */
  plugins?: string[];
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
  /** When --repeats > 1, distinguishes runs of the same eval (0..N-1). */
  repeatIdx?: number;
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
  /** Deterministic assertion results (null when no assertions defined). */
  assertions?: AssertionResults | null;
  /** Final composite score combining assertions + judge (0-100).
   *  When assertions exist: 0.6 * assertionScore + 0.4 * judgeScore.
   *  When no assertions: equal to judge score. */
  finalScore?: number | null;
  error?: string;
  /** True when this eval was never started due to an interrupt (Ctrl+C) */
  skipped?: boolean;
}

export interface EvalRunResults {
  timestamp: string;
  totalDuration: number;
  evalCount: number;
  /** Number of times each eval was run (1 = no repeats). */
  repeats?: number;
  /** Run identifier (folder name like "2026-04-17-029"). */
  runId?: string;
  /** Run-level reproducibility metadata. */
  meta?: {
    model?: string;
    judgeModel?: string;
    concurrency?: number;
    cwd?: string;
    cliVersion?: string;
    nodeVersion?: string;
    platform?: string;
    argv?: string[];
  };
  evals: EvalResult[];
}
