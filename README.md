# copilot-eval

An eval framework for the [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli). Write declarative test cases, run them against any installed skill, plugin, or MCP server, and get an automated scorecard — all from the terminal.

## Why?

Skills, plugins, and MCP servers extend what Copilot CLI can do, but there's no built-in way to verify they actually work. A prompt that passed yesterday might silently regress after a config change, a model update, or a refactor of your skill instructions.

**copilot-eval** closes that gap:

- **Catch regressions** — run evals on every change to your skill, plugin, or MCP config and spot breakages before users do.
- **Measure quality** — get a 0–100 score for each eval with pass / partial / fail verdicts, plus aggregate stats by category.
- **Iterate faster** — skip the judge (`--skip-judge`) to tighten the prompt-tweak → test loop, or run a single eval by index while debugging.
- **Compare models** — switch the backing model (`--model`) and re-run the same suite to see how different LLMs handle your prompts.

## How it works

```
evals.json ──→ Runner ──→ Skill Output ──→ Judge ──→ Scorecard
                 │                           │
                 ▼                           ▼
           Isolated workspace         LLM-as-judge
           (one per eval)             (automated verdict)
```

1. **Load** — reads `evals.json` from your eval project and applies any filters (category, pattern, index).
2. **Execute** — for each eval, spins up an isolated temp workspace, then pipes the prompt to the Copilot CLI with your skill loaded. Multi-turn conversations are supported.
3. **Judge** — sends the skill's output (tool calls, file changes, CLI response) and your expected-behavior description to an LLM-as-judge, which returns a structured JSON verdict.
4. **Report** — prints a live progress display with per-eval results, then a summary scorecard. Full results, logs, and an HTML dashboard are saved to `runs/`.

## Quick start

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed globally (`copilot` on your `$PATH`)

### Install

```bash
# Clone and build from source
git clone <repo-url> && cd copilot-eval
npm install
npm run build

# Or link globally for the `copilot-eval` command
npm link
```

### Create an eval project

```bash
copilot-eval init my-evals
cd my-evals
```

This scaffolds:

```
my-evals/
  evals.json           — your eval cases (prompt + expected behavior)
  package.json         — npm scripts for setup/teardown hooks
  .copilot-eval/       — JSON schema for editor validation
  runs/                — output from each run
```

### Define evals

Edit `evals.json`. Each eval has a title, one or more conversation turns, and an optional category:

```json
{
  "$schema": "./.copilot-eval/evals.schema.json",
  "evals": [
    {
      "title": "Scaffold a new agent project",
      "category": "scaffolding",
      "turns": [
        {
          "prompt": "Create a new declarative agent called 'HelloBot'",
          "expected": "Creates a project directory with a valid declarative agent manifest"
        }
      ]
    },
    {
      "title": "Add an MCP tool to an existing agent",
      "category": "mcp",
      "turns": [
        {
          "prompt": "Add an MCP weather tool that calls the OpenWeather API",
          "expected": "Adds a tools entry in the manifest pointing to an MCP server config"
        }
      ]
    }
  ]
}
```

### Run evals

```bash
# Run all evals against a skill
copilot-eval run --skill m365-agent-developer

# Run a single eval by index (0-based)
copilot-eval run --skill m365-agent-developer --eval 0

# Run evals matching a pattern
copilot-eval run --skill m365-agent-developer --filter "MCP"

# Run only a specific category
copilot-eval run --skill m365-agent-developer --category scaffolding

# Skip the judge (fast iteration on skill behavior)
copilot-eval run --skill m365-agent-developer --skip-judge

# Change the model
copilot-eval run --skill m365-agent-developer --model claude-sonnet-4.5

# Adjust parallelism (default: 5)
copilot-eval run --skill m365-agent-developer --concurrency 2
```

### Read results

Each run produces a timestamped folder under `runs/`:

```
runs/
  2026-03-07-001/
    2026-03-07-001.json     — structured results (every eval + judgment)
    2026-03-07-001.html     — visual dashboard
    2026-03-07-001.log      — full run log
    logs/                   — per-session response and Copilot process logs
    workspaces/             — preserved workspace for each eval
```

The console prints a live scorecard as evals complete:

```
  🟢 [01/04] Scaffold a new agent project — Pass (92/100)   3.2s
  🟡 [02/04] Add an MCP tool              — Partial (65/100) 4.1s
  🔴 [03/04] Configure auth               — Fail (20/100)    2.8s
  ⏭️  [04/04] List available tools          — Done (exit 0)    1.5s
```

## Setup & teardown hooks

`evals.json` supports shell scripts that run at different lifecycle points — useful for provisioning test fixtures, seeding data, or cleaning up.

```json
{
  "scripts": {
    "setup": "echo 'Runs once before all evals'",
    "teardown": "echo 'Runs once after all evals'",
    "setup:eval": "echo 'Default per-eval setup (can be overridden)'",
    "teardown:eval": "echo 'Default per-eval teardown (can be overridden)'"
  },
  "evals": [
    {
      "title": "Eval with custom setup",
      "scripts": {
        "setup": "cp -r fixtures/ {{workspaceDir}}/"
      },
      "turns": [{ "prompt": "...", "expected": "..." }]
    }
  ]
}
```

**Placeholders** available in scripts: `{{runId}}`, `{{runDir}}`, `{{projectDir}}`, `{{workspaceId}}`, `{{workspaceDir}}`.  
These are also exposed as environment variables: `COPILOT_EVAL_RUN_ID`, `COPILOT_EVAL_RUN_DIR`, etc.

## What can I eval?

copilot-eval works with anything the Copilot CLI can load:

| Extension type | What it is | Example eval |
|---|---|---|
| **Skill** | A `.md` instruction file in `~/.copilot/skills/` | "Scaffold a new M365 agent project" |
| **Plugin** | A tool plugin registered with the CLI | "Search our internal docs for deployment guides" |
| **MCP server** | A Model Context Protocol server providing tools | "Query the database for active users" |

The eval doesn't care how the capability is implemented — it sends a prompt, captures the full session output, and judges whether the expected behavior occurred.

## CLI reference

```
copilot-eval init [dir]           Scaffold a new eval project
copilot-eval run                  Run evals from the current project

Options for `run`:
  -s, --skill <name>              Skill name (required, must exist in ~/.copilot/skills/)
  -e, --eval <index>              Run a single eval by 0-based index
  -f, --filter <pattern>          Run evals matching a regex pattern
      --category <name>           Run evals in a specific category
  -o, --output <file>             Save results to a specific file
      --skip-judge                Skip the judging step
  -m, --model <model>             Copilot CLI model (default: claude-opus-4.6-fast)
  -c, --concurrency <n>           Parallel eval slots (default: 5)
  -v, --verbose                   Print all script output and phase changes
```

## Building from source

```bash
npm install         # install dependencies
npm run build       # compile TypeScript to dist/
npm test            # run unit tests
npm run build:binary  # produce a standalone binary (no Node required)
```

## License

MIT
