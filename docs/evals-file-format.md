# Evals File Format

The evals file defines the test cases for your skill. It supports three file names, checked in order:

1. `evals.yaml` (preferred)
2. `evals.yml`
3. `evals.json` (legacy)

YAML is recommended because it supports multiline strings natively, making complex `expected_response` fields much easier to write.

---

## Structure

```yaml
scripts:
  setup: "echo 'runs once before all evals'"
  teardown: "echo 'runs once after all evals'"
  setup:eval: "echo 'runs before each eval (default)'"
  teardown:eval: "echo 'runs after each eval (default)'"

evals:
  - title: "Short description of the eval"
    category: "optional-category"
    scripts:
      setup: "echo 'per-eval setup (overrides setup:eval)'"
      teardown: "echo 'per-eval teardown (overrides teardown:eval)'"
    turns:
      - prompt: "The user prompt sent to the Copilot CLI"
        expected_response: "Description of what the judge should check for"
```

### Top-Level Fields

| Field | Required | Description |
|-------|----------|-------------|
| `scripts` | No | Global setup/teardown hooks |
| `evals` | **Yes** | Array of eval cases |

### Eval Case Fields

| Field | Required | Description |
|-------|----------|-------------|
| `title` | **Yes** | Short descriptive title (shown in reports) |
| `turns` | **Yes** | One or more conversation turns |
| `category` | No | Category string for filtering with `--category` |
| `scripts` | No | Per-eval setup/teardown (overrides global `setup:eval`/`teardown:eval`) |

### Turn Fields

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | **Yes** | The user prompt sent to the Copilot CLI |
| `expected_response` | **Yes** | Description of expected behavior — used by the LLM judge |

---

## Examples

### Minimal — Single Eval

```yaml
evals:
  - title: "Create a hello world project"
    turns:
      - prompt: "Create a hello world project in Python"
        expected_response: "Should create a Python file with a print('Hello, World!') statement"
```

### Categorized Evals

Use categories to organize and selectively run subsets of evals.

```yaml
evals:
  - title: "Scaffold a Teams bot"
    category: scaffolding
    turns:
      - prompt: "Create a new Teams bot project"
        expected_response: "Should use Teams Toolkit to scaffold a bot project with proper manifest"

  - title: "Add SSO authentication"
    category: capabilities
    turns:
      - prompt: "Add SSO authentication to my Teams app"
        expected_response: "Should configure AAD app registration and add auth middleware"

  - title: "Deploy to Azure"
    category: deployment
    turns:
      - prompt: "Deploy my agent to Azure"
        expected_response: "Should provision Azure resources and deploy the application"
```

Run a single category:

```bash
copilot-eval run --skill m365-agent-developer --category scaffolding
```

### Multi-Turn Conversation

Multi-turn evals test a sequence of prompts in a single Copilot session. After the first turn, subsequent turns use `--resume` to continue the same conversation.

```yaml
evals:
  - title: "Build and then modify a project"
    turns:
      - prompt: "Create a new Express.js API with a /health endpoint"
        expected_response: |
          Should scaffold an Express.js project with:
          - package.json with express dependency
          - A server file with a /health GET endpoint
          - Proper error handling

      - prompt: "Add a /users endpoint that returns a list of users"
        expected_response: |
          Should add to the existing project:
          - A new /users GET route
          - Sample user data or a users array
          - Should NOT recreate the project from scratch
```

### Multiline Expected Response

YAML block scalars (`|`) make multiline criteria easy to read:

```yaml
evals:
  - title: "Create a declarative agent with API plugin"
    turns:
      - prompt: "Create a declarative agent with an API plugin for weather data"
        expected_response: |
          The agent should include:
          1. A valid declarativeAgent.json manifest
          2. An API plugin configuration pointing to the weather API
          3. OpenAPI spec for the weather endpoints
          4. Proper authentication configuration
          5. Conversation starters related to weather queries

          The agent should NOT:
          - Use deprecated manifest formats
          - Include hardcoded API keys
          - Skip input validation
```

### With Setup and Teardown Scripts

Scripts run shell commands at various lifecycle points. They support `{{placeholder}}` syntax and `COPILOT_EVAL_*` environment variables.

```yaml
scripts:
  setup: "echo 'Global setup — runs once before all evals'"
  teardown: "rm -rf /tmp/eval-artifacts"
  setup:eval: "cp -r ./fixtures/base-project {{workspaceDir}}"
  teardown:eval: "echo 'Eval {{workspaceId}} complete'"

evals:
  - title: "Modify an existing project"
    turns:
      - prompt: "Add unit tests to the existing project"
        expected_response: "Should add a test framework and write tests for existing code"

  - title: "Custom setup for this eval"
    scripts:
      setup: "cp -r ./fixtures/react-project {{workspaceDir}}"
    turns:
      - prompt: "Add TypeScript to the React project"
        expected_response: "Should install TypeScript and convert files from JSX to TSX"
```

**Script execution order:**

1. **Global `setup`** — once, before any eval runs
2. For each eval:
   1. **Per-eval `scripts.setup`** (or global `setup:eval` if not overridden)
   2. **Eval execution** (all turns)
   3. **Per-eval `scripts.teardown`** (or global `teardown:eval` if not overridden)
3. **Global `teardown`** — once, after all evals complete

### Legacy JSON Format

The tool also supports a bare JSON array (no wrapper object). This is for backward compatibility only.

```json
[
  {
    "title": "Create a hello world project",
    "turns": [
      {
        "prompt": "Create a hello world project",
        "expected_response": "Should scaffold a basic project"
      }
    ]
  }
]
```

---

## Script Placeholders

Use `{{name}}` in any script string. They are replaced before execution.

| Placeholder | Scope | Description |
|-------------|-------|-------------|
| `{{runId}}` | All scripts | Run tag, e.g. `2026-03-09-001` |
| `{{runDir}}` | All scripts | Absolute path to the run directory |
| `{{projectDir}}` | All scripts | Absolute path to the eval project |
| `{{workspaceId}}` | Per-eval only | UUID of the eval workspace |
| `{{workspaceDir}}` | Per-eval only | Absolute path to the workspace directory |
| `{{workspacePath}}` | Per-eval only | Alias for `{{workspaceDir}}` |

Scripts also receive the same values as environment variables:

| Environment Variable | Maps To |
|---------------------|---------|
| `COPILOT_EVAL_RUN_ID` | `{{runId}}` |
| `COPILOT_EVAL_RUN_DIR` | `{{runDir}}` |
| `COPILOT_EVAL_PROJECT_DIR` | `{{projectDir}}` |
| `COPILOT_EVAL_WORKSPACE_ID` | `{{workspaceId}}` |
| `COPILOT_EVAL_WORKSPACE_DIR` | `{{workspaceDir}}` |

Scripts run with `sh -c` and have a 5-minute timeout. A non-zero exit code causes the script (and the eval) to fail.

---

## Judging

Each eval is judged by the Copilot CLI itself (LLM-as-judge). The judge receives:

- The user prompt(s)
- The `expected_response` criteria
- The actual skill output

It returns a structured verdict:

| Verdict | Score Range | Meaning |
|---------|-------------|---------|
| **pass** | 80–100 | All key criteria met |
| **partial** | 40–79 | Some criteria met, important ones missing |
| **fail** | 0–39 | Key criteria not met or wrong approach |

The judge evaluates:

1. Did the skill use the correct commands/tools?
2. Did it follow the required workflow steps?
3. Did it avoid prohibited actions?
4. Did it include all required elements?
5. (Multi-turn) Did each turn satisfy its specific expected behavior?

### Writing Good `expected_response` Values

The `expected_response` is what the judge uses to grade the skill output. Tips:

- **Be specific** — "Should create a `manifest.json` with `version: 1.17`" is better than "Should create a manifest"
- **List criteria** — Use numbered lists or bullet points for multiple requirements
- **Include negative criteria** — "Should NOT modify existing files" helps the judge catch regressions
- **Describe behavior, not exact output** — The judge evaluates intent, not string matching
- **Use multiline YAML** — The `|` block scalar makes long criteria readable

```yaml
# ❌ Too vague
expected_response: "Should work correctly"

# ✅ Specific and actionable
expected_response: |
  Should create an Express.js server with:
  1. A /health endpoint returning 200 OK
  2. Error handling middleware
  3. Port configured via PORT environment variable
  Should NOT use deprecated Express 3.x APIs
```
