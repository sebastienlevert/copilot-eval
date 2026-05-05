import { readFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute, relative, sep } from "node:path";
import { runCommand } from "./workspace.js";
import { detectSkillUsage } from "./runner.js";
import type {
  Assertion,
  AssertionResult,
  AssertionResults,
  SkillOutput,
} from "./types.js";

/**
 * Resolve a relative path against the workspace dir; absolute paths pass through.
 */
function resolvePath(workspaceDir: string, p: string): string {
  return isAbsolute(p) ? p : join(workspaceDir, p);
}

/**
 * Convert a glob pattern (supports **, *, ?) into a RegExp.
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (glob[i] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$", "i");
}

/**
 * Recursively collect files under root. Skips node_modules and .git.
 */
async function collectFiles(root: string, prefix = "", out: string[] = []): Promise<string[]> {
  if (!existsSync(root)) return out;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const rel = prefix ? prefix + "/" + ent.name : ent.name;
    if (ent.isDirectory()) {
      await collectFiles(join(root, ent.name), rel, out);
    } else if (ent.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * SHA-256 hash of a file's contents. Returns null if the file doesn't exist.
 */
async function fileHash(absPath: string): Promise<string | null> {
  if (!existsSync(absPath)) return null;
  try {
    const buf = await readFile(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Read a file as UTF-8, returning null if it doesn't exist or can't be read.
 */
async function safeRead(absPath: string): Promise<string | null> {
  if (!existsSync(absPath)) return null;
  try {
    return await readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Evaluate a single JSONPath-lite expression. Supports:
 *   $                    → root
 *   $.foo                → property
 *   $["$schema"]         → bracketed property (handles special chars like $)
 *   $.foo.bar            → nested
 *   $.foo[0]             → array index
 *   $.foo[*]             → all array elements (returns array)
 *   $.foo.length         → special length accessor for arrays/strings
 *
 * Returns undefined if the path doesn't resolve. For [*] expansions, returns
 * an array of values.
 */
export function evalJsonPath(root: unknown, path: string): unknown {
  if (!path || path === "$") return root;
  // Tokenize into segments. Supports .foo, ["foo"], ['foo'], [N], [*]
  const tokens: Array<string | number | "*"> = [];
  let i = 0;
  if (path[0] === "$") i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      i++;
      let name = "";
      while (i < path.length && /[A-Za-z0-9_$\-]/.test(path[i])) {
        name += path[i++];
      }
      if (name) tokens.push(name);
    } else if (ch === "[") {
      i++;
      // Quoted string: ["..."] or ['...']
      if (path[i] === '"' || path[i] === "'") {
        const quote = path[i++];
        let s = "";
        while (i < path.length && path[i] !== quote) s += path[i++];
        i++; // closing quote
        if (path[i] === "]") i++;
        tokens.push(s);
      } else if (path[i] === "*") {
        i++;
        if (path[i] === "]") i++;
        tokens.push("*");
      } else {
        let n = "";
        while (i < path.length && path[i] !== "]") n += path[i++];
        i++;
        const num = Number(n);
        if (Number.isFinite(num)) tokens.push(num);
        else tokens.push(n);
      }
    } else {
      i++; // skip unknown
    }
  }

  let current: unknown = root;
  for (const tok of tokens) {
    if (current === undefined || current === null) return undefined;
    if (tok === "*") {
      if (Array.isArray(current)) {
        // Subsequent tokens apply to each element. For simplicity, return the
        // array itself; further drilling-down is not supported beyond [*].
        return current;
      }
      return undefined;
    }
    if (typeof tok === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[tok];
    } else {
      // Special: .length on string/array
      if (tok === "length" && (typeof current === "string" || Array.isArray(current))) {
        return (current as { length: number }).length;
      }
      if (typeof current === "object") {
        current = (current as Record<string, unknown>)[tok];
      } else {
        return undefined;
      }
    }
  }
  return current;
}

/**
 * Snapshot file hashes BEFORE the eval runs, for any assertions that need
 * pre-execution state (file_unchanged, file_changed). Returns a map of
 * absolute path → SHA-256 hex (or null if the file didn't exist pre-run).
 */
export async function snapshotForAssertions(
  workspaceDir: string,
  assertions: Assertion[] | undefined,
): Promise<Map<string, string | null>> {
  const snap = new Map<string, string | null>();
  if (!assertions) return snap;
  for (const a of assertions) {
    if (a.type === "file_unchanged" || a.type === "file_changed") {
      const abs = resolvePath(workspaceDir, a.path);
      snap.set(abs, await fileHash(abs));
    }
  }
  return snap;
}

/**
 * Build a human-readable label for an assertion, used in result output.
 */
export function describeAssertion(a: Assertion): string {
  if (a.description) return a.description;
  switch (a.type) {
    case "file_exists": return `file_exists: ${a.path}`;
    case "file_not_exists": return `file_not_exists: ${a.path}`;
    case "file_glob_exists": return `file_glob_exists: ${a.glob}${a.minMatches ? ` (min ${a.minMatches})` : ""}`;
    case "file_contains": return `file_contains: ${a.path} matches /${a.pattern}/${a.flags ?? ""}`;
    case "json_path": {
      const op = a.matches ? `matches /${a.matches}/` : a.equals !== undefined ? `equals ${JSON.stringify(a.equals)}` : a.exists === false ? "does not exist" : "exists";
      return `json_path: ${a.path} ${a.jsonPath} ${op}`;
    }
    case "transcript_matches": return `transcript_matches: /${a.pattern}/${a.flags ?? ""}`;
    case "transcript_not_matches": return `transcript_not_matches: /${a.pattern}/${a.flags ?? ""}`;
    case "skill_invoked": return `skill_invoked: ${a.skill}`;
    case "file_unchanged": return `file_unchanged: ${a.path}`;
    case "file_changed": return `file_changed: ${a.path}`;
    case "cli_exit_zero": return `cli_exit_zero: ${a.command}`;
    case "file_diff": return `file_diff: ${a.path} vs ${a.golden}`;
  }
}

/**
 * Run all assertions for an eval. Returns per-assertion pass/fail plus a
 * normalized 0-100 score. When `assertions` is undefined or empty, returns
 * a results object with score: null (signals "no deterministic assertions").
 */
export async function runAssertions(
  assertions: Assertion[] | undefined,
  ctx: {
    workspaceDir: string;
    skillOutput: SkillOutput;
    snapshots: Map<string, string | null>;
  },
): Promise<AssertionResults> {
  if (!assertions || assertions.length === 0) {
    return { results: [], passed: 0, failed: 0, total: 0, score: null };
  }

  const results: AssertionResult[] = [];
  for (const a of assertions) {
    results.push(await runOne(a, ctx));
  }
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const score = results.length === 0 ? null : Math.round((passed / results.length) * 100);
  return { results, passed, failed, total: results.length, score };
}

async function runOne(
  a: Assertion,
  ctx: {
    workspaceDir: string;
    skillOutput: SkillOutput;
    snapshots: Map<string, string | null>;
  },
): Promise<AssertionResult> {
  const ws = ctx.workspaceDir;
  switch (a.type) {
    case "file_exists": {
      const abs = resolvePath(ws, a.path);
      const ok = existsSync(abs);
      return { assertion: a, passed: ok, reason: ok ? "file present" : `file not found at ${abs}` };
    }
    case "file_glob_exists": {
      const files = await collectFiles(ws);
      const re = globToRegExp(a.glob);
      const matches = files.filter((f) => re.test(f));
      const min = a.minMatches ?? 1;
      const ok = matches.length >= min;
      return {
        assertion: a,
        passed: ok,
        reason: ok
          ? `glob matched ${matches.length} file(s)${matches.length <= 3 ? `: ${matches.join(", ")}` : ""}`
          : `glob ${a.glob} matched ${matches.length} file(s), need ≥ ${min}`,
      };
    }
    case "file_not_exists": {
      const abs = resolvePath(ws, a.path);
      const ok = !existsSync(abs);
      return { assertion: a, passed: ok, reason: ok ? "file absent" : `file unexpectedly present at ${abs}` };
    }
    case "file_contains": {
      const abs = resolvePath(ws, a.path);
      const text = await safeRead(abs);
      if (text === null) return { assertion: a, passed: false, reason: `file not readable: ${abs}` };
      const re = new RegExp(a.pattern, a.flags);
      const ok = re.test(text);
      return { assertion: a, passed: ok, reason: ok ? "pattern found in file" : `pattern not found in ${a.path}` };
    }
    case "json_path": {
      const abs = resolvePath(ws, a.path);
      const text = await safeRead(abs);
      if (text === null) return { assertion: a, passed: false, reason: `file not readable: ${abs}` };
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch (e) {
        return { assertion: a, passed: false, reason: `JSON parse failed: ${(e as Error).message}` };
      }
      const value = evalJsonPath(parsed, a.jsonPath);
      const exists = value !== undefined;
      if (a.exists === false) {
        return { assertion: a, passed: !exists, reason: !exists ? "value absent as expected" : `value present: ${JSON.stringify(value).slice(0, 80)}` };
      }
      if (!exists) return { assertion: a, passed: false, reason: `path did not resolve: ${a.jsonPath}` };
      if (a.equals !== undefined) {
        const ok = JSON.stringify(value) === JSON.stringify(a.equals);
        return { assertion: a, passed: ok, reason: ok ? "value matches expected" : `value=${JSON.stringify(value).slice(0, 80)} expected=${JSON.stringify(a.equals).slice(0, 80)}` };
      }
      if (a.matches !== undefined) {
        const re = new RegExp(a.matches);
        const str = typeof value === "string" ? value : JSON.stringify(value);
        const ok = re.test(str);
        return { assertion: a, passed: ok, reason: ok ? "regex matched" : `value did not match /${a.matches}/: ${str.slice(0, 80)}` };
      }
      // No equals/matches → just existence check
      return { assertion: a, passed: true, reason: "value exists at path" };
    }
    case "transcript_matches": {
      const re = new RegExp(a.pattern, a.flags);
      const ok = re.test(ctx.skillOutput.response);
      return { assertion: a, passed: ok, reason: ok ? "pattern found in transcript" : "pattern NOT found in transcript" };
    }
    case "transcript_not_matches": {
      const re = new RegExp(a.pattern, a.flags);
      const ok = !re.test(ctx.skillOutput.response);
      return { assertion: a, passed: ok, reason: ok ? "pattern absent (as required)" : "forbidden pattern was present in transcript" };
    }
    case "skill_invoked": {
      // Use the existing detector but additionally require the specific skill name to appear.
      const text = (ctx.skillOutput.sessionLog || "") + ctx.skillOutput.response;
      const generic = detectSkillUsage(ctx.skillOutput.sessionLog, ctx.skillOutput.response);
      const named = new RegExp(`skill\\(${a.skill.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\)`, "i").test(text)
        || new RegExp(`\\\\?\"skill\\\\?\"\\s*:\\s*\\\\?\"${a.skill.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\\\?\"`, "i").test(text);
      const ok = named || (generic && new RegExp(a.skill, "i").test(text));
      return { assertion: a, passed: ok, reason: ok ? `skill ${a.skill} invoked` : `skill ${a.skill} not invoked` };
    }
    case "file_unchanged": {
      const abs = resolvePath(ws, a.path);
      const before = ctx.snapshots.get(abs) ?? null;
      const after = await fileHash(abs);
      const ok = before === after;
      return { assertion: a, passed: ok, reason: ok ? "file unchanged" : `file changed (before=${(before ?? "<absent>").slice(0, 8)} after=${(after ?? "<absent>").slice(0, 8)})` };
    }
    case "file_changed": {
      const abs = resolvePath(ws, a.path);
      const before = ctx.snapshots.get(abs) ?? null;
      const after = await fileHash(abs);
      const ok = before !== after;
      return { assertion: a, passed: ok, reason: ok ? "file changed" : "file was not modified" };
    }
    case "cli_exit_zero": {
      const cwd = a.cwd ? resolvePath(ws, a.cwd) : ws;
      const parts = a.command.split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);
      try {
        const r = await runCommand(cmd, args, { cwd, timeout: 60_000 });
        const ok = r.code === 0;
        return { assertion: a, passed: ok, reason: ok ? `${a.command} exited 0` : `${a.command} exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 120)}` };
      } catch (e) {
        return { assertion: a, passed: false, reason: `command failed: ${(e as Error).message}` };
      }
    }
    case "file_diff": {
      const abs = resolvePath(ws, a.path);
      const goldenAbs = resolvePath(ws, a.golden);
      const actual = await safeRead(abs);
      const expected = await safeRead(goldenAbs);
      if (actual === null) return { assertion: a, passed: false, reason: `actual file missing: ${abs}` };
      if (expected === null) return { assertion: a, passed: false, reason: `golden file missing: ${goldenAbs}` };
      // Normalize whitespace/line endings before comparing
      const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/g, "").trim();
      const ok = norm(actual) === norm(expected);
      return { assertion: a, passed: ok, reason: ok ? "file matches golden" : "file differs from golden" };
    }
  }
}

/**
 * Combine the assertion score with the judge score into a final 0-100 score.
 *
 * Rules:
 * - No assertions: final = judge score.
 * - All assertions pass: final = 0.4 * assertionScore (=40) + 0.6 * judgeScore.
 *   In practice this means a perfect deterministic pass + perfect judge = 100,
 *   and the deterministic side cushions noisy judging.
 * - Any assertion fails: final = 0.6 * assertionScore + 0.4 * judgeScore.
 *   Assertions weigh more when something deterministically wrong was found,
 *   so the score reflects the objective failure.
 */
export function combineScores(judgeScore: number, assertionScore: number | null): number {
  if (assertionScore === null) return judgeScore;
  // When everything deterministic passes, weight the judge slightly more so
  // semantic quality still drives the score upward.
  const allPassed = assertionScore === 100;
  const w = allPassed ? { a: 0.4, j: 0.6 } : { a: 0.6, j: 0.4 };
  return Math.round(w.a * assertionScore + w.j * judgeScore);
}
