# CLI Reference

`copilot-eval` is the command-line tool for running skill evaluations against the GitHub Copilot CLI.

## Commands

### `copilot-eval init [dir]`

Scaffold a new eval project.

```bash
# Initialize in the current directory
copilot-eval init

# Initialize in a new directory
copilot-eval init my-evals

# Overwrite an existing project
copilot-eval init --force
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--force` | `false` | Overwrite existing files |

**Created files:**

```
my-evals/
├── evals.yaml                       # Eval cases (edit this)
├── package.json                     # Project metadata
├── .copilot-eval/
│   ├── evals.schema.json            # JSON schema for editor validation
│   └── .gitkeep
└── runs/
    └── .gitkeep
```

---

### `copilot-eval run`

Run evals from the current eval project directory.

```bash
# Run all evals for a skill
copilot-eval run --skill m365-agent-developer

# Run a single eval by index (0-based)
copilot-eval run --skill m365-agent-developer --eval 5

# Run evals matching a regex pattern
copilot-eval run --skill m365-agent-developer --filter "MCP"

# Run evals in a specific category
copilot-eval run --skill m365-agent-developer --category scaffolding

# Skip judging (faster iteration)
copilot-eval run --skill m365-agent-developer --skip-judge

# Use a different model
copilot-eval run --skill m365-agent-developer --model claude-sonnet-4

# Run with higher parallelism and verbose output
copilot-eval run --skill m365-agent-developer -c 10 -v
```

**Options:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-s, --skill <name>` | string | **(required)** | Skill name — searched recursively in `~/.copilot/` |
| `-e, --eval <index>` | number | — | Run a single eval by 0-based index |
| `--category <name>` | string | — | Run only evals with this category |
| `-f, --filter <pattern>` | string | — | Run evals whose title or prompts match a regex (case-insensitive) |
| `-o, --output <file>` | string | — | Save results JSON to a custom path |
| `--skip-judge` | boolean | `false` | Skip the LLM-as-judge step |
| `-m, --model <model>` | string | `claude-opus-4.6` | Model for both skill execution and judging |
| `-c, --concurrency <n>` | number | `5` | Maximum parallel evals |
| `-v, --verbose` | boolean | `false` | Print timestamped logs for every phase and script output |

**Run output structure:**

```
runs/
└── 2026-03-09-001/
    ├── 2026-03-09-001.json           # Results data
    ├── 2026-03-09-001.html           # Interactive HTML dashboard
    ├── 2026-03-09-001.log            # Full run log
    ├── logs/
    │   ├── <session-id>-response.log # Agent response per eval
    │   └── <session-id>-session.log  # Copilot process log per eval
    └── workspaces/
        └── <session-id>/             # Preserved workspace per eval
```

**Behavior details:**

- **Skill discovery:** Recursively searches `~/.copilot/` for a directory matching the skill name (skips `node_modules`, `logs`, `session-state`, `runs`).
- **Throttle handling:** Automatically retries up to 3 times with exponential backoff (15s → 30s → 60s) on rate-limit detection.
- **Live display:** Shows a spinner with per-eval progress, phase, and elapsed time. Final line shows verdict and score.
- **Workspaces:** Each eval runs in an isolated workspace directory that is preserved after the run for debugging.

---

## Skill Discovery

The `--skill` flag accepts a skill folder name. The tool searches recursively through `~/.copilot/` to find it:

```
~/.copilot/
├── skills/
│   └── m365-agent-developer/     ✅ Found
├── plugins/
│   └── my-custom-skill/          ✅ Found
└── teams/
    └── nested/
        └── another-skill/        ✅ Found
```

The first match wins. Directories named `node_modules`, `logs`, `session-state`, and `runs` are skipped during search.
