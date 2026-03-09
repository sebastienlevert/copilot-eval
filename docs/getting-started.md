# Getting Started

This guide walks you through setting up and running your first skill evaluation.

## Prerequisites

- **Node.js** 18+ installed
- **Copilot CLI** installed globally (`copilot` command available)
- A **Copilot CLI skill** installed in `~/.copilot/` (in any subfolder)

## Installation

From the repository root:

```bash
npm install
npm run build
npm install -g .
```

Verify the installation:

```bash
copilot-eval --version
```

## Create an Eval Project

```bash
mkdir my-skill-evals
cd my-skill-evals
copilot-eval init
```

This creates:

```
my-skill-evals/
├── evals.yaml             # Your eval cases — edit this
├── package.json
├── .copilot-eval/
│   └── evals.schema.json  # Schema for editor validation
└── runs/                  # Output directory (auto-populated)
```

## Write Your First Evals

Edit `evals.yaml`:

```yaml
evals:
  - title: "Create a basic web project"
    category: scaffolding
    turns:
      - prompt: "Create a simple Node.js web server"
        expected_response: |
          Should create a Node.js project with:
          - A package.json with appropriate dependencies
          - A server file listening on a port
          - A basic route that returns a response

  - title: "Add authentication"
    category: capabilities
    turns:
      - prompt: "Add JWT authentication to the server"
        expected_response: |
          Should add:
          - JWT dependency (jsonwebtoken or similar)
          - Auth middleware that validates tokens
          - Protected routes
          Should NOT remove existing routes
```

## Run Evals

```bash
# Run all evals
copilot-eval run --skill my-skill-name

# Run a single eval for quick testing
copilot-eval run --skill my-skill-name --eval 0

# Run without judging (faster iteration)
copilot-eval run --skill my-skill-name --skip-judge

# Run only a category
copilot-eval run --skill my-skill-name --category scaffolding
```

## Read Results

After a run completes, you'll see:

1. **Console scorecard** — summary with pass/fail/partial for each eval
2. **JSON results** — `runs/<run-tag>/<run-tag>.json` with full data
3. **HTML dashboard** — `runs/<run-tag>/<run-tag>.html` — open in a browser
4. **Run log** — `runs/<run-tag>/<run-tag>.log` — timestamped execution log
5. **Workspaces** — `runs/<run-tag>/workspaces/<id>/` — preserved working directories

Example console output:

```
════════════════════════════════════════════════════════════
  SKILL EVAL RESULTS
════════════════════════════════════════════════════════════
  Skill:    my-skill-name
  Date:     2026-03-09T23:00:00.000Z
  Duration: 45.2s
────────────────────────────────────────────────────────────
  Total: 2  ✅ Pass: 1  🟡 Partial: 1  ❌ Fail: 0  💥 Error: 0
  Average Score: 82.5/100
────────────────────────────────────────────────────────────
  ✅ [ 0] ( 95) Create a basic web project                  12.3s
       ↳ Turn 1: Create a simple Node.js web server
  🟡 [ 1] ( 70) Add authentication                          18.1s
       ↳ Turn 1: Add JWT authentication to the server
       ↳ Missing: Auth middleware not applied to routes
════════════════════════════════════════════════════════════
  Pass Rate:          50.0%
  Pass+Partial Rate:  100.0%
════════════════════════════════════════════════════════════
```

## Next Steps

- See [CLI Reference](./cli-reference.md) for all commands and flags
- See [Evals File Format](./evals-file-format.md) for the full YAML schema, multi-turn examples, and script hooks
