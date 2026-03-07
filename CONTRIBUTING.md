# Contributing to copilot-eval

Thanks for your interest in contributing! This guide will get you from clone to pull request as quickly as possible.

## Prerequisites

- **Node.js** v20 or later
- **Git**
- **GitHub Copilot CLI** installed globally (only needed to run evals end-to-end, not for unit tests)

## Getting started

```bash
# 1. Fork and clone
git clone <your-fork-url>
cd copilot-eval

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Run tests
npm test
```

That's it — if the tests pass, you're ready to contribute.

## Project structure

```
copilot-eval/
├── src/
│   ├── cli.ts                 # CLI entrypoint (Commander.js)
│   ├── lib/
│   │   ├── types.ts           # Shared TypeScript interfaces
│   │   ├── init.ts            # `copilot-eval init` — scaffolds eval projects
│   │   ├── workspace.ts       # Workspace creation, script runner, placeholder resolution
│   │   ├── runner.ts          # Executes evals via the Copilot CLI
│   │   ├── judge.ts           # LLM-as-judge — scores skill output
│   │   ├── reporter.ts        # Console scorecard and summary builder
│   │   ├── dashboard.ts       # HTML dashboard generator
│   │   ├── *.test.ts          # Unit tests (co-located with source)
│   ├── templates/
│   │   ├── evals.schema.json  # JSON schema for evals.json
│   │   └── dashboard.html     # HTML template for the dashboard
├── scripts/
│   └── build-binary.js        # Standalone binary builder (esbuild + Node SEA)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Development workflow

### Build

```bash
npm run build        # TypeScript → dist/, copies templates
```

The build compiles `src/` to `dist/` with `tsc` and copies `src/templates/` into `dist/templates/`. Always build before testing the CLI manually.

### Test

```bash
npm test             # Run all tests once
npm run test:watch   # Re-run on file changes (great for TDD)
```

Tests use [Vitest](https://vitest.dev/) and live next to the source files (`*.test.ts`). They are pure unit tests — no Copilot CLI or network access required. Each test file creates temp directories and cleans up after itself.

### Run the CLI locally

```bash
# Via node directly (after building)
node dist/cli.js init my-test-evals
node dist/cli.js run --skill my-skill

# Or link globally for the `copilot-eval` command
npm link
copilot-eval init my-test-evals
```

### Build a standalone binary

```bash
npm run build:binary   # Produces out/copilot-eval (no Node required)
```

This uses esbuild to bundle everything into a single CJS file, then Node's Single Executable Application (SEA) feature to produce a self-contained binary.

## Architecture overview

The eval pipeline has four stages:

```
Load → Execute → Judge → Report
```

| Stage | Module | What it does |
|---|---|---|
| **Load** | `workspace.ts` | Reads `evals.json`, applies filters, creates isolated workspaces |
| **Execute** | `runner.ts` | Pipes each prompt to `copilot` CLI via stdin, captures output |
| **Judge** | `judge.ts` | Sends output + expectations to an LLM-as-judge, parses JSON verdict |
| **Report** | `reporter.ts` | Builds a console scorecard and saves structured results |

The CLI (`cli.ts`) orchestrates these stages with a concurrent worker pool, live progress display, throttle detection with backoff, and setup/teardown hook execution.

### Key design decisions

- **Isolated workspaces** — each eval runs in its own temp directory so evals never interfere with each other.
- **Multi-turn support** — an eval can have multiple conversation turns that share the same Copilot session.
- **JSON verdict parsing** — the judge's response parser has a fallback chain (fenced code block → raw JSON → structured failure). Follow this pattern if modifying judge output.
- **Workspaces are preserved** — never deleted after runs, so you can inspect what the skill actually did.

## Writing tests

All new functionality should include tests. Follow the existing patterns:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("myFeature", () => {
  it("does the expected thing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "copilot-eval-test-"));
    // ... test logic using `dir` as a scratch space
    expect(result).toBe(expected);
  });
});
```

Tips:
- Use `mkdtemp` for temp directories — each test gets its own.
- Tests should be fast and self-contained — no network calls, no Copilot CLI dependency.
- Co-locate tests with source: `src/lib/foo.ts` → `src/lib/foo.test.ts`.

## Making changes

1. **Create a branch** from `main` for your work.
2. **Make your changes** in `src/`. Keep changes focused — one feature or fix per PR.
3. **Add or update tests** for any new or changed behavior.
4. **Build and test** before submitting:
   ```bash
   npm run build && npm test
   ```
5. **Open a pull request** with a clear description of what changed and why.

### Commit messages

Write clear, concise commit messages. Use the imperative mood:

```
Add --timeout flag for per-eval time limits
Fix judge JSON parsing when response contains markdown
```

## Conventions

- **TypeScript** — all source is in `src/`, compiled to `dist/` via `tsc` with strict mode.
- **ESM** — the project uses ES modules (`"type": "module"` in package.json). Use `.js` extensions in imports.
- **Single runtime dependency** — we intentionally keep dependencies minimal. Currently only `commander` is a production dependency. Think carefully before adding new ones.
- **No linter configured** — keep code style consistent with the existing codebase.

## Questions?

Open an issue if something in this guide is unclear or if you're unsure where to start. We're happy to help!
