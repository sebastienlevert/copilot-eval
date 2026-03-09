#!/usr/bin/env node

import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createWorkspace, loadEvals, saveResults, runScript, type ScriptVariables } from "./lib/workspace.js";
import { executeEval, isThrottled } from "./lib/runner.js";
import { judgeEval } from "./lib/judge.js";
import { printSummary, buildSummary } from "./lib/reporter.js";
import { generateDashboard } from "./lib/dashboard.js";
import { initEvalProject } from "./lib/init.js";
import type { EvalCase, EvalResult, EvalRunResults, EvalsFile } from "./lib/types.js";

const COPILOT_DIR = join(homedir(), ".copilot");

/** Recursively search for a directory named `skillName` anywhere under `baseDir`. */
function findSkillPath(baseDir: string, skillName: string): string | null {
  // Check direct child first (fast path for ~/.copilot/skills/<name>, ~/.copilot/plugins/<name>, etc.)
  if (!existsSync(baseDir)) return null;

  const entries = readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === skillName) return join(baseDir, entry.name);
  }
  // Recurse into subdirectories (skip node_modules, logs, session-state, runs)
  const SKIP = new Set(["node_modules", "logs", "session-state", "runs"]);
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    const found = findSkillPath(join(baseDir, entry.name), skillName);
    if (found) return found;
  }
  return null;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface DisplayLine {
  evalIdx: number;
  title: string;
  phase: string;
  startTime: number;
  finalText: string | null;
}

function createLiveDisplay(total: number, verbose = false, logBuffer?: string[]) {
  let frame = 0;
  let completed = 0;
  const pad = Math.max(2, String(total).length);
  const totalStr = String(total).padStart(pad, "0");
  const lines: DisplayLine[] = [];
  let renderedLines = 0;

  function prefix(evalIdx: number): string {
    return `[${String(evalIdx + 1).padStart(pad, "0")}/${totalStr}]`;
  }

  function truncate(text: string): string {
    const cols = process.stdout.columns || 80;
    if (text.length >= cols) return text.slice(0, cols - 2) + "…";
    return text;
  }

  function render() {
    // Move cursor up to rewrite the block
    if (renderedLines > 0) {
      process.stdout.write(`\x1b[${renderedLines}A`);
    }
    const now = Date.now();
    for (const line of lines) {
      let text: string;
      if (line.finalText) {
        text = line.finalText;
      } else {
        const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
        const sec = Math.floor((now - line.startTime) / 1000);
        text = `  ${f} ${prefix(line.evalIdx)} ${line.title} — ${line.phase} (${sec}s)`;
      }
      // Erase line, write truncated content, move to next line
      process.stdout.write(`\r\x1b[2K${truncate(text)}\n`);
    }
    renderedLines = lines.length;
  }

  const interval = verbose ? null : setInterval(() => {
    frame++;
    if (lines.length > 0) render();
  }, 500);

  function ts(): string {
    return new Date().toISOString();
  }

  function emit(line: string) {
    console.log(line);
    if (logBuffer) logBuffer.push(line);
  }

  return {
    start(evalIdx: number, title: string) {
      if (verbose) {
        emit(`${ts()} [INFO] ${prefix(evalIdx)} ${title}`);
      }
      lines.push({ evalIdx, title, phase: "Running", startTime: Date.now(), finalText: null });
    },
    update(evalIdx: number, phase: string) {
      const line = lines.find(l => l.evalIdx === evalIdx);
      if (line && !line.finalText) line.phase = phase;
      if (verbose) {
        const title = line?.title || "";
        emit(`${ts()} [INFO] ${prefix(evalIdx)} ${title} — ${phase}`);
      }
    },
    log(evalIdx: number, output: string) {
      if (verbose && output) {
        const trimmed = output.trim();
        for (const ln of trimmed.split("\n")) {
          emit(`${ts()} [LOG]  ${prefix(evalIdx)} ${ln}`);
        }
      }
    },
    finish(evalIdx: number, icon: string, summary: string) {
      completed++;
      const line = lines.find(l => l.evalIdx === evalIdx);
      if (line) {
        const dur = ((Date.now() - line.startTime) / 1000).toFixed(1);
        line.finalText = truncate(`  ${icon} ${prefix(line.evalIdx)} ${line.title} — ${summary}  ${dur}s`);
      }
      if (verbose) {
        const title = line?.title || "";
        const dur = line ? ((Date.now() - line.startTime) / 1000).toFixed(1) : "?";
        emit(`${ts()} [INFO] ${icon} ${prefix(evalIdx)} ${title} — ${summary}  ${dur}s`);
      }
    },
    stop() {
      if (interval) clearInterval(interval);
      if (!verbose) render();
    },
  };
}

const program = new Command();

program
  .name("copilot-eval")
  .description("Eval framework for Copilot CLI skills")
  .version("1.0.0");

program
  .command("init [dir]")
  .description("Initialize a new eval project")
  .option("--force", "Overwrite existing files", false)
  .action(async (dir: string = ".", opts: { force: boolean }) => {
    await initEvalProject(dir, opts.force);
  });

interface RunOptions {
  skill: string;
  eval?: string;
  category?: string;
  filter?: string;
  output?: string;
  skipJudge: boolean;
  concurrency: string;
  model: string;
  verbose: boolean;
}

program
  .command("run")
  .description("Run evals from the current eval project directory")
  .requiredOption("-s, --skill <name>", "Skill name (searches recursively in ~/.copilot/)")
  .option("-e, --eval <index>", "Run a specific eval by index (0-based)")
  .option("--category <name>", "Run evals in a specific category")
  .option("-f, --filter <pattern>", "Run evals matching a prompt pattern")
  .option("-o, --output <file>", "Save results to a specific file")
  .option("--skip-judge", "Skip the judging step", false)
  .option("-v, --verbose", "Print all script output and phase changes", false)
  .option("-c, --concurrency <n>", "Number of evals to run in parallel", "5")
  .option("-m, --model <model>", "Copilot CLI model to use", "claude-opus-4.6")
  .action(async (opts: RunOptions) => {
    const projectDir = process.cwd();
    const concurrency = parseInt(opts.concurrency, 10);
    const startTime = Date.now();

    // Log buffer for saving to run log file
    const logBuffer: string[] = [];

    // Logging helper: prepends timestamp in verbose mode, always buffers with timestamp
    const log = (msg: string) => {
      const line = `${new Date().toISOString()} [INFO] ${msg}`;
      logBuffer.push(line);
      console.log(opts.verbose ? line : msg);
    };
    const logOut = (msg: string) => {
      const line = `${new Date().toISOString()} [LOG]  ${msg}`;
      logBuffer.push(line);
      console.log(opts.verbose ? line : msg);
    };
    const logErr = (msg: string) => {
      const line = `${new Date().toISOString()} [ERROR] ${msg}`;
      logBuffer.push(line);
      console.error(opts.verbose ? line : msg);
    };

    // Validate we're in an eval project
    if (!existsSync(join(projectDir, "evals.yaml")) && !existsSync(join(projectDir, "evals.yml")) && !existsSync(join(projectDir, "evals.json"))) {
      logErr("❌ No evals.yaml found in current directory. Run `copilot-eval init` first.");
      process.exit(1);
    }

    // Validate skill is installed
    const skillPath = findSkillPath(COPILOT_DIR, opts.skill);
    if (!skillPath) {
      logErr(`❌ Skill "${opts.skill}" not found in ${COPILOT_DIR} (searched recursively)`);
      process.exit(1);
    }
    log(`✅ Skill "${opts.skill}": ${skillPath}`);

    // Create a sequentially numbered run directory: YYYY-MM-DD-NNN
    const runsDir = join(projectDir, "runs");
    const datePrefix = new Date().toISOString().slice(0, 10);
    let seq = 1;
    if (existsSync(runsDir)) {
      const existing = readdirSync(runsDir)
        .filter((d) => d.startsWith(datePrefix))
        .sort();
      if (existing.length > 0) {
        const last = existing[existing.length - 1];
        const lastSeq = parseInt(last.slice(11), 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
      }
    }
    const runTag = `${datePrefix}-${String(seq).padStart(3, "0")}`;
    const runDir = join(runsDir, runTag);
    await mkdir(join(runDir, "logs"), { recursive: true });
    await mkdir(join(runDir, "workspaces"), { recursive: true });
    log(`📂 Run directory: ${runDir}`);

    // Save log on interrupt (Ctrl+C)
    const onInterrupt = () => {
      logErr(`⚠️  Interrupted — saving log`);
      const logPath = join(runDir, `${runTag}.log`);
      try {
        writeFileSync(logPath, logBuffer.join("\n") + "\n");
        console.error(`📝 Run log saved to ${logPath}`);
      } catch {}
      process.exit(130);
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);

    log(`🔍 Evals file: ${projectDir}/evals.yml`);
    const evalsFile: EvalsFile = await loadEvals(projectDir);
    let evals: EvalCase[] = evalsFile.evals;

    if (opts.eval !== undefined) {
      const idx = parseInt(opts.eval, 10);
      if (idx < 0 || idx >= evals.length) {
        logErr(`❌ Eval index ${idx} out of range (0-${evals.length - 1})`);
        process.exit(1);
      }
      evals = [evals[idx]];
    } else if (opts.category) {
      evals = evals.filter((e) => e.category === opts.category);
      log(`  Filtered to ${evals.length} evals in category "${opts.category}"`);
    } else if (opts.filter) {
      const pattern = new RegExp(opts.filter, "i");
      evals = evals.filter(
        (e) => pattern.test(e.title) || e.turns.some((t) => pattern.test(t.prompt) || pattern.test(t.expected_response)),
      );
      log(`  Filtered to ${evals.length} evals matching "${opts.filter}"`);
    }

    if (evals.length === 0) {
      log("No evals to run.");
      process.exit(0);
    }

    log(`📋 Running ${evals.length} eval(s)`);

    // Global script variables
    const globalVars: ScriptVariables = { runId: runTag, runDir, projectDir };

    // Global setup
    if (evalsFile.scripts?.setup) {
      log(`🔧 Running global setup script`);
      const setupResult = await runScript(evalsFile.scripts.setup, projectDir, globalVars);
      const setupOut = (setupResult.stdout + setupResult.stderr).trim();
      if (setupOut) {
        for (const ln of setupOut.split("\n")) {
          logOut(ln);
        }
      }
    }

    const evalResults: EvalResult[] = [];
    const MAX_RETRIES = 3;
    const BACKOFF_BASE_MS = 15_000;
    const display = createLiveDisplay(evals.length, opts.verbose, logBuffer);

    // Worker pool: keeps `concurrency` slots filled at all times
    type QueueItem = { evalCase: EvalCase; evalIdx: number; retries: number };
    const queue: QueueItem[] = evals.map((evalCase, idx) => ({
      evalCase,
      evalIdx: idx,
      retries: 0,
    }));

    async function processItem({ evalCase, evalIdx, retries }: QueueItem): Promise<EvalResult> {
      const shortTitle =
        evalCase.title.length > 40
          ? evalCase.title.slice(0, 37) + "..."
          : evalCase.title;

      display.start(evalIdx, shortTitle);

      while (true) {
        const retryTag = retries > 0 ? ` [retry ${retries}]` : "";
        display.update(evalIdx, `Running${retryTag}`);

        let evalId: string | undefined;
        try {
          const workspace = await createWorkspace(join(runDir, "workspaces"));
          evalId = workspace.id;

          // Per-eval setup (eval-specific overrides global setup:eval)
          const evalSetupCmd = evalCase.scripts?.setup ?? evalsFile.scripts?.["setup:eval"];
          if (evalSetupCmd) {
            display.update(evalIdx, "Setup");
            const evalVars: ScriptVariables = { ...globalVars, workspaceId: workspace.id, workspaceDir: workspace.dir };
            const setupResult = await runScript(evalSetupCmd, projectDir, evalVars);
            const setupOut = (setupResult.stdout + setupResult.stderr).trim();
            if (setupOut) {
              display.log(evalIdx, setupOut);
              display.update(evalIdx, `Setup done`);
            }
          }

          display.update(evalIdx, `Running${retryTag}`);

          const skillOutput = await executeEval(
            evalCase.turns,
            workspace.dir,
            runDir,
            evalId,
            opts.model,
            (turnIdx) => {
              display.update(evalIdx, `Turn ${turnIdx + 1}/${evalCase.turns.length} done`);
            },
          );

          // Check for throttling
          if (isThrottled(skillOutput.response)) {
            if (retries < MAX_RETRIES) {
              retries++;
              const backoffMs = BACKOFF_BASE_MS * Math.pow(2, retries - 1);
              display.update(evalIdx, `Throttled — backoff ${(backoffMs / 1000).toFixed(0)}s`);
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            display.finish(evalIdx, "🕐", "Throttled (max retries)");
            return {
              index: evalIdx,
              sessionId: evalId,
              title: evalCase.title,
              turns: evalCase.turns,
              category: evalCase.category,
              error: "Throttled after max retries",
              duration: skillOutput.duration,
              judgment: null,
            };
          }

          const skillTag = skillOutput.skillUsed ? "" : " [no skill]";

          // Judge
          let judgment = null;
          if (!opts.skipJudge) {
            display.update(evalIdx, `Judging${skillTag}`);
            judgment = await judgeEval(evalCase, skillOutput, opts.model);

            // Check if judge was throttled
            if (judgment.score === 0 && isThrottled(judgment.reasoning)) {
              if (retries < MAX_RETRIES) {
                retries++;
                const backoffMs = BACKOFF_BASE_MS * Math.pow(2, retries - 1);
                display.update(evalIdx, `Judge throttled — backoff ${(backoffMs / 1000).toFixed(0)}s`);
                await new Promise((r) => setTimeout(r, backoffMs));
                continue;
              }
            }
          }

          // Per-eval teardown (eval-specific overrides global teardown:eval)
          const evalTeardownCmd = evalCase.scripts?.teardown ?? evalsFile.scripts?.["teardown:eval"];
          if (evalTeardownCmd) {
            display.update(evalIdx, "Teardown");
            const evalVars: ScriptVariables = { ...globalVars, workspaceId: workspace.id, workspaceDir: workspace.dir };
            const tdResult = await runScript(evalTeardownCmd, projectDir, evalVars).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              display.update(evalIdx, `Teardown failed: ${msg}`);
              return null;
            });
            if (tdResult) {
              const tdOut = (tdResult.stdout + tdResult.stderr).trim();
              if (tdOut) {
                display.log(evalIdx, tdOut);
                display.update(evalIdx, `Teardown done`);
              }
            }
          }

          if (!opts.skipJudge && judgment) {
            const icon =
              judgment.verdict === "pass" ? "🟢" :
              judgment.verdict === "partial" ? "🟡" : "🔴";
            const verdict = judgment.verdict.charAt(0).toUpperCase() + judgment.verdict.slice(1);
            display.finish(evalIdx, icon, `${verdict} (${judgment.score}/100)${skillTag}`);
          } else {
            const exitTag = skillOutput.exitCode === 0 ? "exit 0" : `exit ${skillOutput.exitCode}`;
            display.finish(evalIdx, "⏭️", `Done (${exitTag})${skillTag}`);
          }

          return {
            index: evalIdx,
            sessionId: evalId,
            title: evalCase.title,
            turns: evalCase.turns,
            category: evalCase.category,
            response: skillOutput.response,
            turnResponses: skillOutput.turnResponses,
            exitCode: skillOutput.exitCode,
            duration: skillOutput.duration,
            skillUsed: skillOutput.skillUsed,
            judgment,
          };
        } catch (err) {
          // Per-eval teardown on error (best-effort)
          const errorTeardownCmd = evalCase.scripts?.teardown ?? evalsFile.scripts?.["teardown:eval"];
          if (errorTeardownCmd) {
            const errorVars: ScriptVariables = { ...globalVars, workspaceId: evalId, workspaceDir: join(runDir, "workspaces", evalId || "") };
            await runScript(errorTeardownCmd, projectDir, errorVars).catch((tdErr) => {
              const msg = tdErr instanceof Error ? tdErr.message : String(tdErr);
              display.update(evalIdx, `Teardown failed: ${msg}`);
            });
          }
          const message = err instanceof Error ? err.message : String(err);
          const shortErr = message.length > 40 ? message.slice(0, 37) + "..." : message;
          display.finish(evalIdx, "💥", `Error: ${shortErr}`);
          return {
            index: evalIdx,
            sessionId: evalId,
            title: evalCase.title,
            turns: evalCase.turns,
            category: evalCase.category,
            error: message,
            duration: 0,
            judgment: null,
          };
        }
      }
    }

    // Pool: as soon as one slot finishes, the next item starts immediately
    const active = new Set<Promise<void>>();
    let idx = 0;
    let poolResolve: () => void;
    const poolDone = new Promise<void>((r) => (poolResolve = r));

    function launchNext() {
      if (idx >= queue.length) {
        if (active.size === 0) poolResolve();
        return;
      }
      const item = queue[idx++];
      const p = processItem(item).then((result) => {
        evalResults.push(result);
        active.delete(p);
        launchNext();
      });
      active.add(p);
    }

    // Seed the pool with up to `concurrency` workers
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
      launchNext();
    }
    await poolDone;
    display.stop();

    // Global teardown
    if (evalsFile.scripts?.teardown) {
      log(`🔧 Running global teardown script`);
      const teardownResult = await runScript(evalsFile.scripts.teardown, projectDir, globalVars).catch((err) => {
        logErr(`⚠️  Global teardown failed: ${err instanceof Error ? err.message : err}`);
        return null;
      });
      if (teardownResult) {
        const tdOut = (teardownResult.stdout + teardownResult.stderr).trim();
        if (tdOut) {
          for (const ln of tdOut.split("\n")) {
            logOut(ln);
          }
        }
      }
    }

    // Sort results by original index
    evalResults.sort((a, b) => a.index - b.index);

    const results: EvalRunResults = {
      skill: opts.skill,
      timestamp: new Date().toISOString(),
      totalDuration: Date.now() - startTime,
      evalCount: evalResults.length,
      evals: evalResults,
    };

    const summary = buildSummary(results);
    console.log(summary);
    logBuffer.push(summary);

    const savedPath = opts.output
      ? await saveResults(resolve(opts.output, ".."), results, `${runTag}.json`)
      : await saveResults(runDir, results, `${runTag}.json`);
    log(`💾 Results: ${savedPath}`);

    const dashboardPath = await generateDashboard(runDir, `${runTag}.html`, results);
    log(`📊 Dashboard: ${dashboardPath}`);

    // Save run log
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    const logPath = join(runDir, `${runTag}.log`);
    await writeFile(logPath, logBuffer.join("\n") + "\n");
    log(`📝 Log: ${logPath}`);
  });

program.parse();
