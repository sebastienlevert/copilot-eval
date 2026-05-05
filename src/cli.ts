#!/usr/bin/env node

import { Command } from "commander";
import { resolve, join, dirname } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createWorkspace, loadEvals, saveResults, runScript, type ScriptVariables } from "./lib/workspace.js";
import { executeEval, isThrottled, isTransientError, shouldRetryRun } from "./lib/runner.js";
import { judgeEval } from "./lib/judge.js";
import { snapshotForAssertions, runAssertions, combineScores } from "./lib/assertions.js";
import { printSummary, buildSummary } from "./lib/reporter.js";
import { generateDashboard } from "./lib/dashboard.js";
import { startServer } from "./lib/serve.js";
import { initEvalProject } from "./lib/init.js";
import type { EvalCase, EvalResult, EvalRunResults, EvalsFile } from "./lib/types.js";

function getCliVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
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
  eval?: string;
  id?: string;
  category?: string;
  filter?: string;
  variance?: string;
  output?: string;
  file?: string;
  skipJudge: boolean;
  concurrency: string;
  model: string;
  judgeModel: string;
  repeats: string;
  verbose: boolean;
  agent?: string;
}

program
  .command("run")
  .description("Run evals from the current eval project directory")
  .option("-e, --eval <index>", "Run a specific eval by index (0-based)")
  .option("--id <id>", "Run a specific eval by its id field (e.g., --id eval-05)")
  .option("--category <name>", "Run evals in a specific category")
  .option("-f, --filter <pattern>", "Run evals matching a prompt pattern")
  .option("--variance <value>", "Include evals tagged with this variance (e.g., '1p', '3p'). Untagged evals always run.")
  .option("--file <path>", "Use a specific eval file instead of evals.yaml")
  .option("-o, --output <file>", "Save results to a specific file")
  .option("--skip-judge", "Skip the judging step", false)
  .option("-v, --verbose", "Print all script output and phase changes", false)
  .option("-c, --concurrency <n>", "Number of evals to run in parallel", "5")
  .option("-m, --model <model>", "Copilot CLI model to use for evals", "claude-opus-4.6")
  .option("--judge-model <model>", "Copilot CLI model to use for judging", "gpt-4.1")
  .option("--repeats <n>", "Run each eval N times to measure variance (mean/median/stddev are reported)", "1")
  .option("--agent <name>", "Run every eval inside a specific custom agent (passed to `copilot --agent <name>`). Per-eval `agent:` overrides this. Use to A/B-test prompts with vs. without an orchestrator agent.")
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

    // Validate we're in an eval project (skip if --file is provided)
    if (opts.file) {
      const filePath = resolve(projectDir, opts.file);
      if (!existsSync(filePath)) {
        logErr(`❌ Eval file not found: ${opts.file}`);
        process.exit(1);
      }
    } else if (!existsSync(join(projectDir, "evals.yaml")) && !existsSync(join(projectDir, "evals.yml")) && !existsSync(join(projectDir, "evals.json"))) {
      logErr("❌ No evals.yaml found in current directory. Run `copilot-eval init` first, or use --file <path>.");
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

    // Reproducibility metadata captured for the dashboard
    const runMeta = {
      model: opts.model,
      judgeModel: opts.judgeModel,
      concurrency: parseInt(opts.concurrency, 10),
      cwd: projectDir,
      cliVersion: getCliVersion(),
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      argv: process.argv.slice(2),
      agent: opts.agent ?? null,
      variance: opts.variance ?? null,
    };

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

    const evalFilePath = opts.file ? resolve(projectDir, opts.file) : undefined;
    log(`🔍 Evals file: ${evalFilePath ?? join(projectDir, "evals.yaml")}`);
    const evalsFile: EvalsFile = await loadEvals(projectDir, evalFilePath);
    let evals: EvalCase[] = evalsFile.evals;

    // Set up isolated config dir and collect plugin dirs if plugins are specified
    let configDir: string | undefined;
    const pluginDirs: string[] = [];
    const installedPluginsRegistry: Array<{
      name: string;
      marketplace: string;
      version: string;
      installed_at: string;
      enabled: boolean;
      cache_path: string;
      source: { source: string; path: string };
    }> = [];
    if (evalsFile.plugins && evalsFile.plugins.length > 0) {
      configDir = join(runDir, ".copilot");
      await mkdir(join(configDir, "logs"), { recursive: true });

      for (const pluginPath of evalsFile.plugins) {
        // Resolve relative to the eval file's directory when --file is used, otherwise CWD
        const baseDir = evalFilePath ? resolve(evalFilePath, "..") : projectDir;
        const resolvedPath = resolve(baseDir, pluginPath);
        const realSource = await realpath(resolvedPath).catch(() => {
          logErr(`❌ Plugin path not found: ${resolvedPath} (from "${pluginPath}")`);
          process.exit(1);
          return ""; // unreachable
        });
        const pluginName = resolvedPath.replace(/[\\/]/g, "/").split("/").pop()!;
        pluginDirs.push(realSource);
        log(`🔗 Plugin "${pluginName}": ${realSource}`);

        // Mirror the plugin into <config-dir>/installed-plugins/_direct/<pluginName>
        // and register it in config.json so `--agent <pluginName>:<agentName>` resolves.
        // Copilot CLI only loads agents/skills from plugins listed in config.json's
        // `installedPlugins`, regardless of `--plugin-dir`. Use a junction (Windows) /
        // symlink (POSIX) so the local plugin source remains the single source of truth.
        const directDir = join(configDir, "installed-plugins", "_direct");
        await mkdir(directDir, { recursive: true });
        const linkPath = join(directDir, pluginName);
        try {
          await symlink(realSource, linkPath, "junction");
        } catch (e: unknown) {
          const err = e as NodeJS.ErrnoException;
          if (err.code !== "EEXIST") throw e;
        }
        installedPluginsRegistry.push({
          name: pluginName,
          marketplace: "",
          version: "0.0.0",
          installed_at: new Date().toISOString(),
          enabled: true,
          cache_path: linkPath,
          source: { source: "local", path: pluginPath },
        });
      }

      // Write a minimal config.json registering the mirrored plugins. Without this,
      // copilot ignores the files under installed-plugins/_direct.
      const minimalConfig = {
        experimental: true,
        trustedFolders: [projectDir],
        installedPlugins: installedPluginsRegistry,
        enabledPlugins: {},
      };
      await writeFile(join(configDir, "config.json"), JSON.stringify(minimalConfig, null, 2));
      log(`🔒 Isolated config dir: ${configDir} (${evalsFile.plugins.length} plugin(s))`);
    }

    // Variance filtering — always applied before category/filter/index.
    // Evals with no variance field always run. Evals with a variance field
    // only run when that variance is explicitly requested via --variance.
    {
      const beforeCount = evals.length;
      evals = evals.filter((e) => {
        if (!e.variance) return true;
        if (!opts.variance) return false;
        return e.variance === opts.variance;
      });
      const skipped = beforeCount - evals.length;
      if (skipped > 0) {
        log(`  🎯 Variance "${opts.variance ?? "(none)"}": kept ${evals.length}, skipped ${skipped}`);
      }
    }

    if (opts.id) {
      const idPattern = opts.id;
      const matched = evals.filter((e: any) => e.id === idPattern);
      if (matched.length === 0) {
        logErr(`❌ No eval found with id "${idPattern}". Available IDs: ${evals.filter((e: any) => e.id).map((e: any) => e.id).join(", ") || "(none)"}`);
        process.exit(1);
      }
      evals = matched;
      log(`  Filtered to ${evals.length} eval(s) with id "${idPattern}"`);
    } else if (opts.eval !== undefined) {
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
    const globalVars: ScriptVariables = { runId: runTag, runDir, projectDir, variance: opts.variance };

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
    const display = createLiveDisplay(evals.length * Math.max(1, parseInt(opts.repeats, 10) || 1), opts.verbose, logBuffer);

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
        runId: runTag,
        meta: runMeta,
        evals: sorted,
      };
      await Promise.all([
        writeFile(resultsPath, JSON.stringify(partial, null, 2)),
        generateDashboard(runDir, `${runTag}.html`, partial),
        writeFile(logPath, logBuffer.join("\n") + "\n"),
      ]);
    }

    // Worker pool: keeps `concurrency` slots filled at all times
    type QueueItem = { evalCase: EvalCase; evalIdx: number; repeatIdx: number; slotIdx: number; retries: number };
    const repeats = Math.max(1, parseInt(opts.repeats, 10) || 1);
    if (repeats > 1) {
      log(`🔁 Repeats: ${repeats} (each eval will run ${repeats} times)`);
    }
    const queue: QueueItem[] = [];
    for (let r = 0; r < repeats; r++) {
      for (let idx = 0; idx < evals.length; idx++) {
        queue.push({ evalCase: evals[idx], evalIdx: idx, repeatIdx: r, slotIdx: queue.length, retries: 0 });
      }
    }

    async function processItem({ evalCase, evalIdx, repeatIdx, slotIdx, retries }: QueueItem): Promise<EvalResult> {
      const shortTitle =
        evalCase.title.length > 40
          ? evalCase.title.slice(0, 37) + "..."
          : evalCase.title;
      const repeatTag = repeats > 1 ? ` (run ${repeatIdx + 1}/${repeats})` : "";

      display.start(slotIdx, shortTitle + repeatTag);

      while (true) {
        const retryTag = retries > 0 ? ` [retry ${retries}]` : "";
        display.update(slotIdx, `Running${retryTag}`);

        let evalId: string | undefined;
        try {
          const workspace = await createWorkspace(join(runDir, "workspaces"));
          evalId = workspace.id;

          // Per-eval setup (eval-specific overrides global setup:eval)
          const evalSetupCmd = evalCase.scripts?.setup ?? evalsFile.scripts?.["setup:eval"];
          if (evalSetupCmd) {
            display.update(slotIdx, "Setup");
            const evalVars: ScriptVariables = { ...globalVars, workspaceId: workspace.id, workspaceDir: workspace.dir };
            try {
              const setupResult = await runScript(evalSetupCmd, projectDir, evalVars);
              const setupOut = (setupResult.stdout + setupResult.stderr).trim();
              if (setupOut) {
                display.log(slotIdx, setupOut);
                display.update(slotIdx, `Setup done`);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              display.finish(slotIdx, "💥", "Setup failed");
              return {
                index: evalIdx,
                repeatIdx,
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

          display.update(slotIdx, `Running${retryTag}`);

          // Snapshot file hashes for any file_unchanged/file_changed assertions
          const assertionSnapshots = await snapshotForAssertions(workspace.dir, evalCase.assertions);

          const skillOutput = await executeEval(
            evalCase.turns,
            workspace.dir,
            runDir,
            evalId,
            opts.model,
            (turnIdx) => {
              display.update(slotIdx, `Turn ${turnIdx + 1}/${evalCase.turns.length} done`);
            },
            configDir,
            pluginDirs.length > 0 ? pluginDirs : undefined,
            evalCase.agent ?? opts.agent,
          );

          // Check for throttling (only retry if the CLI itself didn't
          // finish cleanly — a clean exit means the CLI was not throttled,
          // even if the agent narrated "rate limit" to the user).
          if (skillOutput.exitCode !== 0 && isThrottled(skillOutput.response)) {
            if (retries < MAX_RETRIES) {
              retries++;
              const backoffMs = BACKOFF_BASE_MS * Math.pow(2, retries - 1);
              display.update(slotIdx, `Throttled — backoff ${(backoffMs / 1000).toFixed(0)}s`);
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            display.finish(slotIdx, "🕐", "Throttled (max retries)");
            return {
              index: evalIdx,
              repeatIdx,
              sessionId: evalId,
              title: evalCase.title,
              turns: evalCase.turns,
              category: evalCase.category,
              error: `Throttled after max retries (exit ${skillOutput.exitCode})`,
              duration: skillOutput.duration,
              judgment: null,
            };
          }

          // Check for transient infrastructure errors. Gated on exit code so
          // that an agent narrating a backend 500 in an otherwise successful
          // run is NOT treated as a retry candidate.
          if (shouldRetryRun(skillOutput.response, skillOutput.exitCode)) {
            if (retries < MAX_RETRIES) {
              retries++;
              const backoffMs = BACKOFF_BASE_MS * Math.pow(2, retries - 1);
              display.update(slotIdx, `Transient error — retry ${retries} in ${(backoffMs / 1000).toFixed(0)}s`);
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            display.finish(slotIdx, "💥", "Transient error (max retries)");
            return {
              index: evalIdx,
              repeatIdx,
              sessionId: evalId,
              title: evalCase.title,
              turns: evalCase.turns,
              category: evalCase.category,
              error: `Transient error after max retries (exit ${skillOutput.exitCode}): ` + skillOutput.response.slice(0, 200),
              duration: skillOutput.duration,
              judgment: null,
            };
          }

          const skillTag = skillOutput.skillUsed ? "" : " [no skill]";

          // Run deterministic assertions (against workspace state + transcript)
          let assertionResults = null;
          if (evalCase.assertions && evalCase.assertions.length > 0) {
            display.update(slotIdx, `Asserting${skillTag}`);
            assertionResults = await runAssertions(evalCase.assertions, {
              workspaceDir: workspace.dir,
              skillOutput,
              snapshots: assertionSnapshots,
            });
          }

          // Judge
          let judgment = null;
          if (!opts.skipJudge) {
            display.update(slotIdx, `Judging${skillTag}`);
            judgment = await judgeEval(evalCase, skillOutput, opts.judgeModel);

            // Check if judge was throttled or hit transient error
            if (judgment.score === 0 && (isThrottled(judgment.reasoning) || isTransientError(judgment.reasoning))) {
              if (retries < MAX_RETRIES) {
                retries++;
                const backoffMs = BACKOFF_BASE_MS * Math.pow(2, retries - 1);
                display.update(slotIdx, `Judge error — retry ${retries} in ${(backoffMs / 1000).toFixed(0)}s`);
                await new Promise((r) => setTimeout(r, backoffMs));
                continue;
              }
            }
          }

          // Compute final composite score
          const finalScore = judgment
            ? combineScores(judgment.score, assertionResults?.score ?? null)
            : null;

          // Per-eval teardown (eval-specific overrides global teardown:eval)
          const evalTeardownCmd = evalCase.scripts?.teardown ?? evalsFile.scripts?.["teardown:eval"];
          if (evalTeardownCmd) {
            display.update(slotIdx, "Teardown");
            const evalVars: ScriptVariables = { ...globalVars, workspaceId: workspace.id, workspaceDir: workspace.dir };
            const tdResult = await runScript(evalTeardownCmd, projectDir, evalVars).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              display.update(slotIdx, `Teardown failed: ${msg}`);
              return null;
            });
            if (tdResult) {
              const tdOut = (tdResult.stdout + tdResult.stderr).trim();
              if (tdOut) {
                display.log(slotIdx, tdOut);
                display.update(slotIdx, `Teardown done`);
              }
            }
          }

          if (!opts.skipJudge && judgment) {
            const displayScore = finalScore ?? judgment.score;
            const verdictLabel =
              displayScore >= 90 ? "Pass" :
              displayScore >= 60 ? "Partial" : "Fail";
            const icon = displayScore >= 90 ? "🟢" : displayScore >= 60 ? "🟡" : "🔴";
            const aTag = assertionResults
              ? ` [a:${assertionResults.passed}/${assertionResults.total}]`
              : "";
            display.finish(slotIdx, icon, `${verdictLabel} (${displayScore}/100)${aTag}${skillTag}`);
          } else {
            const exitTag = skillOutput.exitCode === 0 ? "exit 0" : `exit ${skillOutput.exitCode}`;
            display.finish(slotIdx, "⏭️", `Done (${exitTag})${skillTag}`);
          }

          return {
            index: evalIdx,
            repeatIdx,
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
            assertions: assertionResults,
            finalScore,
          };
        } catch (err) {
          // Per-eval teardown on error (best-effort)
          const errorTeardownCmd = evalCase.scripts?.teardown ?? evalsFile.scripts?.["teardown:eval"];
          if (errorTeardownCmd) {
            const errorVars: ScriptVariables = { ...globalVars, workspaceId: evalId, workspaceDir: join(runDir, "workspaces", evalId || "") };
            await runScript(errorTeardownCmd, projectDir, errorVars).catch((tdErr) => {
              const msg = tdErr instanceof Error ? tdErr.message : String(tdErr);
              display.update(slotIdx, `Teardown failed: ${msg}`);
            });
          }
          const message = err instanceof Error ? err.message : String(err);
          const shortErr = message.length > 40 ? message.slice(0, 37) + "..." : message;
          display.finish(slotIdx, "💥", `Error: ${shortErr}`);
          return {
            index: evalIdx,
            repeatIdx,
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

    // Add skipped results for any (eval, repeat) combinations that never started
    const completedKeys = new Set(evalResults.map((r) => `${r.index}:${r.repeatIdx ?? 0}`));
    const completedEvalIndices = new Set(evalResults.map((r) => r.index));
    for (let r = 0; r < repeats; r++) {
      for (let i = 0; i < evals.length; i++) {
        const key = `${i}:${r}`;
        if (!completedKeys.has(key)) {
          evalResults.push({
            index: i,
            repeatIdx: r,
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
    }

    if (interrupted) {
      log(`⚠️  Run interrupted — ${completedEvalIndices.size}/${evals.length} evals had at least one completed run`);
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

    // Sort results by original index, then repeat
    evalResults.sort((a, b) => (a.index - b.index) || ((a.repeatIdx ?? 0) - (b.repeatIdx ?? 0)));

    const results: EvalRunResults = {
      timestamp: new Date().toISOString(),
      totalDuration: Date.now() - startTime,
      evalCount: evals.length,
      repeats,
      runId: runTag,
      meta: runMeta,
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

program
  .command("serve")
  .description("Start a local server to browse runs and view dashboards")
  .option("-p, --port <n>", "Port to listen on", "4242")
  .option("-h, --host <host>", "Host to bind to", "127.0.0.1")
  .option("--no-open", "Do not auto-open the browser")
  .action(async (opts: { port: string; host: string; open: boolean }) => {
    await startServer(process.cwd(), {
      port: parseInt(opts.port, 10),
      host: opts.host,
      open: opts.open !== false,
    });
  });

program.parse();
