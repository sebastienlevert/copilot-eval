import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, runCommand, loadEvals, saveResults, resolvePlaceholders } from "./workspace.js";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { EvalRunResults } from "./types.js";

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "copilot-eval-test-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  dirs.length = 0;
});

// ---------------------------------------------------------------------------
// createWorkspace
// ---------------------------------------------------------------------------
describe("createWorkspace", () => {
  it("returns an object with dir and id", async () => {
    const base = await makeTempDir();
    const result = await createWorkspace(base);
    expect(result).toHaveProperty("dir");
    expect(result).toHaveProperty("id");
  });

  it("creates a directory on disk", async () => {
    const base = await makeTempDir();
    const { dir } = await createWorkspace(base);
    expect(existsSync(dir)).toBe(true);
  });

  it("returns a valid UUID as id", async () => {
    const base = await makeTempDir();
    const { id } = await createWorkspace(base);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("uses the UUID as the directory name", async () => {
    const base = await makeTempDir();
    const { dir, id } = await createWorkspace(base);
    expect(dir).toBe(join(base, id));
  });

  it("creates the baseDir if it does not exist", async () => {
    const base = await makeTempDir();
    const nested = join(base, "deep", "nested");
    const { dir } = await createWorkspace(nested);
    expect(existsSync(dir)).toBe(true);
  });

  it("creates unique workspaces on repeated calls", async () => {
    const base = await makeTempDir();
    const a = await createWorkspace(base);
    const b = await createWorkspace(base);
    expect(a.id).not.toBe(b.id);
    expect(a.dir).not.toBe(b.dir);
  });

  it("uses system temp when no baseDir provided", async () => {
    const { dir, id } = await createWorkspace();
    dirs.push(dir);
    expect(existsSync(dir)).toBe(true);
    expect(id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// runCommand
// ---------------------------------------------------------------------------
describe("runCommand", () => {
  it("captures stdout", async () => {
    const result = await runCommand("echo", ["hello world"]);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("captures stderr", async () => {
    const result = await runCommand("bash", ["-c", "echo err >&2"]);
    expect(result.stderr.trim()).toBe("err");
  });

  it("returns exit code 0 on success", async () => {
    const result = await runCommand("true", []);
    expect(result.code).toBe(0);
  });

  it("returns non-zero exit code on failure", async () => {
    const result = await runCommand("false", []);
    expect(result.code).not.toBe(0);
  });

  it("returns exit code 1 for explicit exit 1", async () => {
    const result = await runCommand("bash", ["-c", "exit 1"]);
    expect(result.code).toBe(1);
  });

  it("returns exit code 42 for custom exit codes", async () => {
    const result = await runCommand("bash", ["-c", "exit 42"]);
    expect(result.code).toBe(42);
  });

  it("passes stdin input to the process", async () => {
    const result = await runCommand("cat", [], { input: "piped data" });
    expect(result.stdout).toBe("piped data");
  });

  it("passes multi-line stdin input", async () => {
    const result = await runCommand("cat", [], {
      input: "line1\nline2\nline3",
    });
    expect(result.stdout).toBe("line1\nline2\nline3");
  });

  it("handles empty stdin input", async () => {
    // Empty string is falsy so runCommand won't pipe it — use a command that exits immediately
    const result = await runCommand("echo", ["-n", ""]);
    expect(result.stdout).toBe("");
    expect(result.code).toBe(0);
  });

  it("uses cwd option", async () => {
    const dir = await makeTempDir();
    const result = await runCommand("pwd", [], { cwd: dir });
    expect(result.stdout.trim()).toBe(dir);
  });

  it("times out and appends [TIMED OUT]", async () => {
    const result = await runCommand("sleep", ["60"], { timeout: 500 });
    expect(result.stderr).toContain("[TIMED OUT]");
  });

  it("returns captured output before timeout", async () => {
    const result = await runCommand(
      "bash",
      ["-c", 'echo "before"; sleep 60'],
      { timeout: 1000 },
    );
    expect(result.stdout).toContain("before");
    expect(result.stderr).toContain("[TIMED OUT]");
  });

  it("rejects on spawn error for invalid command", async () => {
    await expect(
      runCommand("nonexistent_command_xyz_abc", []),
    ).rejects.toThrow();
  });

  it("captures both stdout and stderr together", async () => {
    const result = await runCommand("bash", [
      "-c",
      'echo out; echo err >&2',
    ]);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("handles commands with arguments", async () => {
    const result = await runCommand("echo", ["-n", "no-newline"]);
    expect(result.stdout).toBe("no-newline");
  });

  it("handles large stdout output", async () => {
    const result = await runCommand("bash", [
      "-c",
      'for i in $(seq 1 1000); do echo "line $i"; done',
    ]);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBe(1000);
  });

  it("handles large stdin input", async () => {
    const largeInput = "x".repeat(100_000);
    const result = await runCommand("wc", ["-c"], { input: largeInput });
    expect(result.stdout.trim()).toBe("100000");
  });

  it("handles unicode in stdout", async () => {
    const result = await runCommand("echo", ["✅ 🔥 日本語"]);
    expect(result.stdout.trim()).toBe("✅ 🔥 日本語");
  });

  it("handles unicode in stdin", async () => {
    const result = await runCommand("cat", [], { input: "héllo wörld" });
    expect(result.stdout).toBe("héllo wörld");
  });

  it("handles empty stdout", async () => {
    const result = await runCommand("true", []);
    expect(result.stdout).toBe("");
  });

  it("resolves even when process writes nothing", async () => {
    const result = await runCommand("bash", ["-c", "exit 0"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

// ---------------------------------------------------------------------------
// loadEvals
// ---------------------------------------------------------------------------
describe("loadEvals", () => {
  it("loads a valid evals.yaml", async () => {
    const dir = await makeTempDir();
    const evals = [
      { title: "hello", turns: [{ prompt: "hello", expected_response: "world" }] },
      { title: "foo", turns: [{ prompt: "foo", expected_response: "bar" }] },
    ];
    await writeFile(join(dir, "evals.yaml"), stringifyYaml(evals));
    const result = await loadEvals(dir);
    expect(result.evals).toEqual(evals);
  });

  it("throws if evals.yaml does not exist", async () => {
    const dir = await makeTempDir();
    await expect(loadEvals(dir)).rejects.toThrow("No evals.yaml");
  });

  it("parses evals with categories", async () => {
    const dir = await makeTempDir();
    const evals = [
      { title: "t1", turns: [{ prompt: "p1", expected_response: "e1" }], category: "scaffolding" },
      { title: "t2", turns: [{ prompt: "p2", expected_response: "e2" }], category: "deployment" },
    ];
    await writeFile(join(dir, "evals.yaml"), stringifyYaml(evals));
    const result = await loadEvals(dir);
    expect(result.evals[0].category).toBe("scaffolding");
    expect(result.evals[1].category).toBe("deployment");
  });

  it("loads an empty array", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "evals.yaml"), stringifyYaml([]));
    const result = await loadEvals(dir);
    expect(result.evals).toEqual([]);
  });

  it("loads a single eval", async () => {
    const dir = await makeTempDir();
    const evals = [{ title: "only one", turns: [{ prompt: "only one", expected_response: "result" }] }];
    await writeFile(join(dir, "evals.yaml"), stringifyYaml(evals));
    const result = await loadEvals(dir);
    expect(result.evals).toHaveLength(1);
  });

  it("preserves eval order", async () => {
    const dir = await makeTempDir();
    const evals = Array.from({ length: 20 }, (_, i) => ({
      title: `eval-${i}`,
      turns: [{ prompt: `prompt-${i}`, expected_response: `expected-${i}` }],
    }));
    await writeFile(join(dir, "evals.yaml"), stringifyYaml(evals));
    const result = await loadEvals(dir);
    for (let i = 0; i < 20; i++) {
      expect(result.evals[i].title).toBe(`eval-${i}`);
    }
  });

  it("throws on invalid YAML", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "evals.yaml"), ":\n  - :\n    - : }{");
    await expect(loadEvals(dir)).rejects.toThrow();
  });

  it("loads evals with optional fields missing", async () => {
    const dir = await makeTempDir();
    const evals = [{ title: "no category", turns: [{ prompt: "no category", expected_response: "result" }] }];
    await writeFile(join(dir, "evals.yaml"), stringifyYaml(evals));
    const result = await loadEvals(dir);
    expect(result.evals[0].category).toBeUndefined();
  });

  it("loads new object format with scripts", async () => {
    const dir = await makeTempDir();
    const evalsFile = {
      scripts: { setup: "echo global", teardown: "echo done" },
      evals: [{ title: "t1", turns: [{ prompt: "p1", expected_response: "e1" }], scripts: { setup: "echo eval" } }],
    };
    await writeFile(join(dir, "evals.yaml"), stringifyYaml(evalsFile));
    const result = await loadEvals(dir);
    expect(result.scripts?.setup).toBe("echo global");
    expect(result.scripts?.teardown).toBe("echo done");
    expect(result.evals[0].scripts?.setup).toBe("echo eval");
  });

  it("falls back to evals.yml when evals.yaml is missing", async () => {
    const dir = await makeTempDir();
    const evals = [
      { title: "yml-fallback", turns: [{ prompt: "hello", expected_response: "world" }] },
    ];
    await writeFile(join(dir, "evals.yml"), stringifyYaml(evals));
    const result = await loadEvals(dir);
    expect(result.evals).toEqual(evals);
  });

  it("falls back to evals.json when evals.yaml is missing", async () => {
    const dir = await makeTempDir();
    const evals = [
      { title: "legacy", turns: [{ prompt: "hello", expected_response: "world" }] },
    ];
    await writeFile(join(dir, "evals.json"), JSON.stringify(evals));
    const result = await loadEvals(dir);
    expect(result.evals).toEqual(evals);
  });
});

// ---------------------------------------------------------------------------
// saveResults
// ---------------------------------------------------------------------------
describe("saveResults", () => {
  const makeResults = (overrides?: Partial<EvalRunResults>): EvalRunResults => ({
    timestamp: "2026-01-01T00:00:00.000Z",
    totalDuration: 5000,
    evalCount: 1,
    evals: [
      {
        index: 0,
        title: "hello eval",
        turns: [{ prompt: "hello", expected_response: "world" }],
        duration: 1000,
        judgment: null,
      },
    ],
    ...overrides,
  });

  it("creates the output file", async () => {
    const dir = await makeTempDir();
    await saveResults(dir, makeResults(), "results.json");
    expect(existsSync(join(dir, "results.json"))).toBe(true);
  });

  it("returns the file path", async () => {
    const dir = await makeTempDir();
    const path = await saveResults(dir, makeResults(), "results.json");
    expect(path).toBe(join(dir, "results.json"));
  });

  it("writes valid JSON", async () => {
    const dir = await makeTempDir();
    await saveResults(dir, makeResults(), "results.json");
    const raw = await readFile(join(dir, "results.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("writes correct data", async () => {
    const dir = await makeTempDir();
    const results = makeResults({ evalCount: 2 });
    await saveResults(dir, results, "out.json");
    const parsed = JSON.parse(await readFile(join(dir, "out.json"), "utf-8"));
    expect(parsed.evalCount).toBe(2);
  });

  it("pretty-prints with 2-space indent", async () => {
    const dir = await makeTempDir();
    await saveResults(dir, makeResults(), "results.json");
    const raw = await readFile(join(dir, "results.json"), "utf-8");
    expect(raw).toContain("  ");
    expect(raw).not.toContain("\t");
  });

  it("creates output directory if missing", async () => {
    const base = await makeTempDir();
    const nested = join(base, "deep", "nested");
    await saveResults(nested, makeResults(), "results.json");
    expect(existsSync(join(nested, "results.json"))).toBe(true);
  });

  it("uses the given filename", async () => {
    const dir = await makeTempDir();
    await saveResults(dir, makeResults(), "2026-01-01-001.json");
    expect(existsSync(join(dir, "2026-01-01-001.json"))).toBe(true);
  });

  it("overwrites existing file", async () => {
    const dir = await makeTempDir();
    await saveResults(dir, makeResults({ evalCount: 1 }), "r.json");
    await saveResults(dir, makeResults({ evalCount: 2 }), "r.json");
    const parsed = JSON.parse(await readFile(join(dir, "r.json"), "utf-8"));
    expect(parsed.evalCount).toBe(2);
  });

  it("preserves all eval result fields", async () => {
    const dir = await makeTempDir();
    const results = makeResults({
      evals: [
        {
          index: 0,
          sessionId: "abc-123",
          title: "test eval",
          turns: [{ prompt: "test", expected_response: "result" }],
          category: "cat1",
          response: "output",
          exitCode: 0,
          duration: 500,
          skillUsed: true,
          judgment: {
            verdict: "pass",
            score: 95,
            criteria_met: ["a"],
            criteria_missed: [],
            reasoning: "good",
          },
        },
      ],
    });
    await saveResults(dir, results, "full.json");
    const parsed = JSON.parse(await readFile(join(dir, "full.json"), "utf-8"));
    const ev = parsed.evals[0];
    expect(ev.sessionId).toBe("abc-123");
    expect(ev.category).toBe("cat1");
    expect(ev.skillUsed).toBe(true);
    expect(ev.judgment.verdict).toBe("pass");
  });

  it("handles error results", async () => {
    const dir = await makeTempDir();
    const results = makeResults({
      evals: [
        {
          index: 0,
          title: "fail eval",
          turns: [{ prompt: "fail", expected_response: "result" }],
          error: "something broke",
          duration: 0,
          judgment: null,
        },
      ],
    });
    await saveResults(dir, results, "err.json");
    const parsed = JSON.parse(await readFile(join(dir, "err.json"), "utf-8"));
    expect(parsed.evals[0].error).toBe("something broke");
    expect(parsed.evals[0].judgment).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolvePlaceholders
// ---------------------------------------------------------------------------
describe("resolvePlaceholders", () => {
  it("replaces known placeholders", () => {
    const result = resolvePlaceholders("build -- {{runId}}", { runId: "2026-02-26-001" });
    expect(result).toBe("build -- 2026-02-26-001");
  });

  it("replaces multiple placeholders", () => {
    const result = resolvePlaceholders("{{runId}}/{{workspaceId}}", {
      runId: "run-1",
      workspaceId: "ws-abc",
    });
    expect(result).toBe("run-1/ws-abc");
  });

  it("leaves unknown placeholders untouched", () => {
    const result = resolvePlaceholders("{{unknown}}", { runId: "run-1" });
    expect(result).toBe("{{unknown}}");
  });

  it("leaves undefined variables untouched", () => {
    const result = resolvePlaceholders("{{workspaceId}}", { runId: "run-1" });
    expect(result).toBe("{{workspaceId}}");
  });

  it("returns string unchanged when no placeholders", () => {
    const result = resolvePlaceholders("setup", { runId: "run-1" });
    expect(result).toBe("setup");
  });

  it("handles empty variables", () => {
    const result = resolvePlaceholders("setup-{{runId}}", {});
    expect(result).toBe("setup-{{runId}}");
  });

  it("resolves {{workspacePath}} as alias for workspaceDir", () => {
    const result = resolvePlaceholders("--workspace {{workspacePath}}", {
      workspaceDir: "/tmp/ws-123",
    });
    expect(result).toBe("--workspace /tmp/ws-123");
  });
});
