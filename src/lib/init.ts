import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EvalsFile } from "./types.js";

const SCAFFOLD_DIRS = ["runs", ".copilot-eval"];

const BLANK_EVALS: EvalsFile = {
  $schema: "./.copilot-eval/evals.schema.json",
  scripts: {
    "setup": "echo 'global setup'",
    "teardown": "echo 'global teardown'",
    "setup:eval": "echo 'default per-eval setup'",
    "teardown:eval": "echo 'default per-eval teardown'",
  },
  evals: [
    {
      title: "Example: hello world project",
      category: "example",
      turns: [
        {
          prompt: "Create a hello world project",
          expected: "Should scaffold a basic project with an entry point",
        },
      ],
    },
  ],
};

const BLANK_PACKAGE_JSON = {
  name: "my-evals",
  version: "1.0.0",
  private: true,
  description: "Eval project for Copilot CLI skills",
};

/**
 * Resolve the path to a template file bundled with copilot-eval.
 * Works from both src/ (dev) and dist/ (compiled).
 */
function templatePath(filename: string): string {
  return join(import.meta.dirname, "..", "templates", filename);
}

/**
 * Initialize a new eval project directory.
 * Creates the folder structure, a starter evals.json, a package.json, and the JSON schema.
 */
export async function initEvalProject(targetDir: string, force = false): Promise<void> {
  const dir = resolve(targetDir);

  if (existsSync(join(dir, ".copilot-eval"))) {
    if (!force) {
      console.error(`❌ .copilot-eval already exists in ${dir}. Use --force to overwrite.`);
      process.exit(1);
    }
  } else if (existsSync(join(dir, "evals.json"))) {
    if (!force) {
      console.error(`❌ evals.json already exists in ${dir}. Use --force to overwrite.`);
      process.exit(1);
    }
  }

  for (const sub of SCAFFOLD_DIRS) {
    await mkdir(join(dir, sub), { recursive: true });
    await writeFile(join(dir, sub, ".gitkeep"), "");
  }

  // Use the target directory basename as the package name
  const dirName = dir.split("/").pop() || "my-evals";
  const pkgJson = { ...BLANK_PACKAGE_JSON, name: dirName };

  await writeFile(
    join(dir, "evals.json"),
    JSON.stringify(BLANK_EVALS, null, 2) + "\n",
  );

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(pkgJson, null, 2) + "\n",
  );

  // Copy the JSON schema into .copilot-eval/
  await copyFile(templatePath("evals.schema.json"), join(dir, ".copilot-eval", "evals.schema.json"));

  console.log(`✅ Initialized eval project in ${dir}`);
  console.log(`   Created:`);
  console.log(`     evals.json                      — define your eval cases here`);
  console.log(`     package.json                    — npm scripts for setup/teardown hooks`);
  console.log(`     .copilot-eval/evals.schema.json  — JSON schema for editor validation`);
  console.log(`     runs/                           — timestamped run folders (results, logs, workspaces)`);
}
