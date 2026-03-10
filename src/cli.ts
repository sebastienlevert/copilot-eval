#!/usr/bin/env node

import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { createWorkspace, loadEvals, saveResults, runScript, type ScriptVariables } from "./lib/workspace.js";
import { executeEval, isThrottled, isTransientError } from "./lib/runner.js";
import { judgeEval } from "./lib/judge.js";
import { printSummary, buildSummary } from "./lib/reporter.js";
import { generateDashboard } from "./lib/dashboard.js";
import { initEvalProject } from "./lib/init.js";
import type { EvalCase, EvalResult, EvalRunResults, EvalsFile } from "./lib/types.js";

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
  eval?: string;
  category?: string;
  filter?: string;
  output?: string;
  skipJudge: boolean;
  concurrency: string;
  model: string;
  judgeModel: string;
  verbose: boolean;
}

program
  .command("run")
  .description("Run evals from the current eval project directory")
  .option("-e, --eval <index>", "Run a specific eval by index (0-based)")
  .option("--category <name>", "Run evals in a specific category")
  .option("-f, --filter <pattern>", "Run evals matching a prompt pattern")
  .option("-o, --output <file>", "Save results to a specific file")
  .option("--skip-judge", "Skip the judging step", false)
  .option("-v, --verbose", "Print all script output and phase changes", false)
  .option("-c, --concurrency <n>", "Number of evals to run in parallel", "5")
  .option("-m, --model <model>", "Copilot CLI model to use for evals", "claude-opus-4.6")
  .option("--judge-model <model>", "Copilot CLI model to use for judging", "gpt-4.1")
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

    // Graceful interrupt: set flag, let pool drain, produce partial report
    let interrupted = false;
    const onInterrupt = () => {
      if (interrupted) {
        // Second Ctrl+C: force exit
        logErr(`⚠️  Force exit`);
        process.exit(130);
      }
      interrupted = true;
      logErr(`\n⚠️  Interrupted — finishing in-flight evals and generating partial report…`);
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);

    log(`🔍 Evals file: ${projectDir}/evals.yaml`);
    const evalsFile: EvalsFile = await loadEvals(projectDir);
    let evals: EvalCase[] = evalsFile.evals;

    // Set up isolated config dir if plugins are specified
    let configDir: string | undefined;
    if (evalsFile.plugins && evalsFile.plugins.length > 0) {
      configDir = join(runDir, ".copilot");
      await mkdir(join(configDir, "installed-plugins", "_eval"), { recursive: true });
      await mkdir(join(configDir, "logs"), { recursive: true });

      for (const pluginPath of evalsFile.plugins) {
        // Resolve absolute or relative-to-evals-file paths
        const resolvedPath = resolve(projectDir, pluginPath);
        const realSource = await realpath(resolvedPath).catch(() => {
          logErr(`❌ Plugin path not found: ${resolvedPath} (from "${pluginPath}")`);
          process.exit(1);
          return ""; // unreachable
        });
        const pluginName = resolvedPath.split("/").pop()!;
        const targetPath = join(configDir, "installed-plugins", "_eval", pluginName);
        await symlink(realSource, targetPath);
        log(`🔗 Plugin "${pluginName}": ${realSource}`);
      }
      log(`🔒 Isolated config dir: ${configDir} (${evalsFile.plugins.length} plugin(s))`);
    }

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
      try {
        const setupResult = await runScript(evalsFile.scripts.setup, projectDir, globalVars);
        const setupOut = (setupResult.stdout + setupResult.stderr).trim();
        if (setupOut) {
          for (const ln of setupOut.split("\n")) {
            logOut(ln);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logErr(`❌ Global setup failed — aborting run`);
        logErr(`   ${message}`);
        await writeFile(join(runDir, `${runTag}.log`), logBuffer.join("\n") + "\n");
        process.exit(1);
      }
    }

    const evalResults: EvalResult[] = [];
    const MAX_RETRIES = 3;
    const BACKOFF_BASE_MS = 15_000;
    const display = createLiveDisplay(evals.length, opts.verbose, logBuffer);

    // Incremental flush: save partial results/log/dashboard after each eval
    const resultsPath = opts.output
      ? join(resolve(opts.output, ".."), `${runTag}.json`)
      : join(runDir, `${runTag}.json`);
    const dashboardOutputPath = join(runDir, `${runTag}.html`);
    const logPath = join(runDir, `${runTag}.log`);

    async function flushResults() {
      const sorted = [...evalResults].sort((a, b) => a.index - b.index);
      const partial: EvalRunResults = {
        timestamp: new Date().toISOString(),
        totalDuration: Date.now() - startTime,
        evalCount: sorted.length,
        evals: sorted,
      };
      await Promise.all([
        writeFile(resultsPath, JSON.stringify(partial, null, 2)),
        generateDashboard(runDir, `${runTag}.html`, partial),
        writeFile(logPath, logBuffer.join("\n") + "\n"),
      ]);
    }

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
            try {
              const setupResult = await runScript(evalSetupCmd, projectDir, evalVars);
              const setupOut = (setupResult.stdout + setupResult.stderr).trim();
              if (setupOut) {
                display.log(evalIdx, setupOut);
                display.update(evalIdx, `Setup done`);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              display.finish(evalIdx, "💥", "Setup failed");
              return {
                index: evalIdx,
                sessionId: evalId,
                title: evalCase.title,
                turns: evalCase.turns,
                category: evalCase.category,
                error: `Setup script failed: ${message}`,
                duration: 0,
                judgment: null,
              };
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
            configDir,
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

          // Check for transient errors (CAPiError, network failures, etc.)
          if (isTransientError(skillOutput.response)) {
            if (retries < MAX_RETRIES) {
              retries++;
              const backoffMs = BACKOFF_BASE_MS * Math.pow(2, retries - 1);
              display.update(evalIdx, `Transient error — retry ${retries} in ${(backoffMs / 1000).toFixed(0)}s`);
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            display.finish(evalIdx, "💥", "Transient error (max retries)");
            return {
              index: evalIdx,
              sessionId: evalId,
              title: evalCase.title,
              turns: evalCase.turns,
              category: evalCase.category,
              error: "Transient error after max retries: " + skillOutput.response.slice(0, 200),
              duration: skillOutput.duration,
              judgment: null,
            };
          }

          const skillTag = skillOutput.skillUsed ? "" : " [no skill]";

          // Judge
          let judgment = null;
          if (!opts.skipJudge) {
            display.update(evalIdx, `Judging${skillTag}`);
            judgment = await judgeEval(evalCase, skillOutput, opts.judgeModel);

            // Check if judge was throttled or hit transient error
            if (judgment.score === 0 && (isThrottled(judgment.reasoning) || isTransientError(judgment.reasoning))) {
              if (retries < MAX_RETRIES) {
                retries++;
                const backoffMs = BACKOFF_BASE_MS * Math.pow(2, retries - 1);
                display.update(evalIdx, `Judge error — retry ${retries} in ${(backoffMs / 1000).toFixed(0)}s`);
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
      // Stop launching new evals if interrupted
      if (interrupted || idx >= queue.length) {
        if (active.size === 0) poolResolve();
        return;
      }
      const item = queue[idx++];
      const p = processItem(item).then(async (result) => {
        evalResults.push(result);
        await flushResults().catch(() => {}); // best-effort incremental save
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

    // Add skipped results for evals that never started
    const completedIndices = new Set(evalResults.map((r) => r.index));
    for (let i = 0; i < evals.length; i++) {
      if (!completedIndices.has(i)) {
        evalResults.push({
          index: i,
          title: evals[i].title,
          turns: evals[i].turns,
          category: evals[i].category,
          error: "Skipped (interrupted)",
          duration: 0,
          judgment: null,
          skipped: true,
        });
      }
    }

    if (interrupted) {
      log(`⚠️  Run interrupted — ${completedIndices.size}/${evals.length} evals completed`);
    }

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
      timestamp: new Date().toISOString(),
      totalDuration: Date.now() - startTime,
      evalCount: evalResults.length,
      evals: evalResults,
    };

    const summary = buildSummary(results);
    console.log(summary);
    logBuffer.push(summary);

    // Final save (overwrites incremental files with complete data)
    await saveResults(
      opts.output ? resolve(opts.output, "..") : runDir,
      results,
      `${runTag}.json`,
    );
    log(`💾 Results: ${resultsPath}`);

    await generateDashboard(runDir, `${runTag}.html`, results);
    log(`📊 Dashboard: ${dashboardOutputPath}`);

    // Save run log
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    await writeFile(logPath, logBuffer.join("\n") + "\n");
    log(`📝 Log: ${logPath}`);
  });

program.parse();
