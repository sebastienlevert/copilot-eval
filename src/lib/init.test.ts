import { describe, it, expect, vi, afterEach } from "vitest";
import { initEvalProject } from "./init.js";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "copilot-eval-init-test-"));
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
// initEvalProject
// ---------------------------------------------------------------------------
describe("initEvalProject", () => {
  it("creates evals.json", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    expect(existsSync(join(dir, "evals.json"))).toBe(true);
  });

  it("creates runs directory", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    expect(existsSync(join(dir, "runs"))).toBe(true);
  });

  it("creates .gitkeep in runs", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    expect(existsSync(join(dir, "runs", ".gitkeep"))).toBe(true);
  });

  it("evals.json contains valid JSON", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    const raw = await readFile(join(dir, "evals.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("evals.json contains an object with evals array", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    const raw = await readFile(join(dir, "evals.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("evals");
    expect(Array.isArray(parsed.evals)).toBe(true);
  });

  it("evals.json contains at least one eval case", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    const raw = await readFile(join(dir, "evals.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.evals.length).toBeGreaterThan(0);
  });

  it("starter eval has title field", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    const parsed = JSON.parse(await readFile(join(dir, "evals.json"), "utf-8"));
    expect(parsed.evals[0]).toHaveProperty("title");
  });

  it("starter eval has turns field", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    const parsed = JSON.parse(await readFile(join(dir, "evals.json"), "utf-8"));
    expect(parsed.evals[0]).toHaveProperty("turns");
    expect(parsed.evals[0].turns[0]).toHaveProperty("prompt");
    expect(parsed.evals[0].turns[0]).toHaveProperty("expected");
  });

  it("starter eval has category field", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    const parsed = JSON.parse(await readFile(join(dir, "evals.json"), "utf-8"));
    expect(parsed.evals[0]).toHaveProperty("category");
  });

  it("evals.json is pretty-printed", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    const raw = await readFile(join(dir, "evals.json"), "utf-8");
    expect(raw).toContain("  ");
  });

  it("evals.json ends with newline", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    const raw = await readFile(join(dir, "evals.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("exits if evals.json already exists", async () => {
    const dir = await makeTempDir();
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await initEvalProject(dir);
    await expect(initEvalProject(dir)).rejects.toThrow("process.exit called");

    mockExit.mockRestore();
  });

  it("exits if .copilot-eval already exists", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".copilot-eval"), { recursive: true });
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(initEvalProject(dir)).rejects.toThrow("process.exit called");

    mockExit.mockRestore();
  });

  it("overwrites when --force is passed", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    // Should not throw with force=true
    await initEvalProject(dir, true);
    expect(existsSync(join(dir, "evals.json"))).toBe(true);
    expect(existsSync(join(dir, ".copilot-eval", "evals.schema.json"))).toBe(true);
  });

  it("resolves relative paths", async () => {
    const dir = await makeTempDir();
    const sub = join(dir, "sub");
    await initEvalProject(sub);
    expect(existsSync(join(sub, "evals.json"))).toBe(true);
  });

  it("creates nested target directories", async () => {
    const dir = await makeTempDir();
    const nested = join(dir, "a", "b", "c");
    await initEvalProject(nested);
    expect(existsSync(join(nested, "evals.json"))).toBe(true);
    expect(existsSync(join(nested, "runs"))).toBe(true);
  });

  it("logs success message", async () => {
    const dir = await makeTempDir();
    const spy = vi.spyOn(console, "log");
    await initEvalProject(dir);
    const messages = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(messages).toContain("Initialized eval project");
    spy.mockRestore();
  });

  it("creates package.json", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    const raw = await readFile(join(dir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    expect(pkg).toHaveProperty("name");
    expect(pkg.private).toBe(true);
  });

  it("creates evals.schema.json in .copilot-eval", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    expect(existsSync(join(dir, ".copilot-eval", "evals.schema.json"))).toBe(true);
    const raw = await readFile(join(dir, ".copilot-eval", "evals.schema.json"), "utf-8");
    const schema = JSON.parse(raw);
    expect(schema).toHaveProperty("definitions");
  });

  it("evals.json references the schema", async () => {
    const dir = await makeTempDir();
    await initEvalProject(dir);
    const parsed = JSON.parse(await readFile(join(dir, "evals.json"), "utf-8"));
    expect(parsed.$schema).toBe("./.copilot-eval/evals.schema.json");
  });
});
