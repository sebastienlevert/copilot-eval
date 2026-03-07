# Copilot Instructions — copilot-eval

## Build & Run

```bash
# Compile TypeScript
npm run build

# Initialize a new eval project
copilot-eval init my-evals
cd my-evals

# Run all evals (must be inside an eval project directory)
copilot-eval run --skill m365-agent-developer

# Run a single eval by 0-based index
copilot-eval run --skill m365-agent-developer --eval 5

# Run evals matching a pattern
copilot-eval run --skill m365-agent-developer --filter "MCP"

# Run evals in a specific category
copilot-eval run --skill m365-agent-developer --category scaffolding

# Skip the judging step (useful for debugging skill output)
copilot-eval run --skill m365-agent-developer --skip-judge

# Build standalone binary (no Node required)
npm run build:binary
```

No tests, no linter. TypeScript compiled via `tsc` to `dist/`. Zero runtime dependencies beyond `commander`.

## Architecture

The eval pipeline is a 4-stage process: **Load → Execute → Judge → Report**.

- **`src/cli.ts`** — CLI entrypoint using Commander.js. Defines `init` and `run` subcommands.
- **`src/lib/types.ts`** — Shared TypeScript interfaces (`EvalCase`, `SkillOutput`, `Judgment`, `EvalResult`, `EvalRunResults`).
- **`src/lib/init.ts`** — Scaffolds a new eval project with `evals.json` and a `runs/` directory.
- **`src/lib/workspace.ts`** — Creates isolated workspace directories for each eval. Also provides `runCommand()`, a promise-wrapped `child_process.spawn` used by both the runner and judge.
- **`src/lib/runner.ts`** — Executes a single eval prompt by invoking the `copilot` CLI in `--yolo --experimental` mode (prompt piped via stdin). Saves agent response and Copilot process log to the run folder, tagged with the Copilot session ID.
- **`src/lib/judge.ts`** — Uses the Copilot CLI as an LLM-as-judge (prompt piped via stdin). Judges against the Copilot session log (falling back to captured stdout/stderr). Parses a JSON verdict (`pass`/`partial`/`fail` with a 0–100 score).
- **`src/lib/reporter.ts`** — Prints a console scorecard with per-eval pass/fail and aggregate stats.

**Eval project structure** (created by `init`):
```
my-evals/
  evals.json                     — eval cases with prompt, expected, and optional category
  runs/
    <timestamp>/                 — one folder per eval run
      results.json               — overall run results
      logs/<session-id>-response.log — agent response
      logs/<session-id>-session.log — Copilot process log
      workspaces/<session-id>/   — preserved workspace for that eval
```

## Conventions

- All source is **TypeScript** in `src/`, compiled to `dist/` via `tsc`.
- The `copilot` CLI is installed globally and invoked directly via `spawn`.
- Workspaces are always preserved — never deleted after runs.
- The judge's JSON parsing has a fallback chain: try fenced code block → try raw JSON → return a structured failure object. Follow this pattern if modifying judge output parsing.
- Binary builds use esbuild to bundle `dist/` into a single CJS file, then Node SEA to produce a standalone executable in `out/`.
