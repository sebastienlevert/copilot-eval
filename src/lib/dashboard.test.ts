import { describe, it, expect, afterEach } from "vitest";
import { generateDashboard } from "./dashboard.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunResults } from "./types.js";

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "copilot-eval-dash-test-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  dirs.length = 0;
});

function makeResults(overrides?: Partial<EvalRunResults>): EvalRunResults {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// generateDashboard
// ---------------------------------------------------------------------------
describe("generateDashboard", () => {
  it("creates the output file", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    expect(existsSync(join(dir, "test.html"))).toBe(true);
  });

  it("returns the file path", async () => {
    const dir = await makeTempDir();
    const path = await generateDashboard(dir, "test.html", makeResults());
    expect(path).toBe(join(dir, "test.html"));
  });

  it("output file contains valid HTML", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("output contains the dashboard title", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("Skill Eval Dashboard");
  });

  it("output contains a script tag", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("<script>");
    expect(html).toContain("</script>");
  });

  it("output contains style tag", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("<style>");
  });

  it("output contains table structure", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody");
  });

  it("output contains filter bar", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("filter-bar");
  });

  it("output contains cards section", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain('id="cards"');
  });

  it("output contains bar chart section", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain('id="bar"');
  });

  it("does not contain the {{DATA}} placeholder", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).not.toContain("{{DATA}}");
  });

  it("uses the given filename", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "2026-01-01-001.html", makeResults());
    expect(existsSync(join(dir, "2026-01-01-001.html"))).toBe(true);
  });

  it("output contains fetch() for JSON loading", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("fetch(");
  });

  it("output references .json extension for data loading", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain(".json");
  });

  it("output contains dark theme CSS variables", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("--bg:");
    expect(html).toContain("--pass:");
    expect(html).toContain("--fail:");
  });

  it("output contains verdict badge classes", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("badge-pass");
    expect(html).toContain("badge-fail");
    expect(html).toContain("badge-partial");
  });

  it("output contains expandable details functionality", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("row-expanded");
    expect(html).toContain("toggle");
  });

  it("output contains table headers", async () => {
    const dir = await makeTempDir();
    await generateDashboard(dir, "test.html", makeResults());
    const html = await readFile(join(dir, "test.html"), "utf-8");
    expect(html).toContain("Verdict");
    expect(html).toContain("Score");
    expect(html).toContain("Title");
    expect(html).toContain("Duration");
  });
});
