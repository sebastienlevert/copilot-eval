import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Best-effort: infer the agent model from response.log files in a run dir
 * by grepping the recorded `--model <name>` CLI arg. Returns undefined if
 * no log is parseable.
 *
 * Used to back-fill `meta.model` for runs produced before the schema gained
 * an explicit meta block.
 */
export async function inferModelFromLogs(runDir: string): Promise<string | undefined> {
  const logsDir = join(runDir, "logs");
  let entries: string[];
  try { entries = await readdir(logsDir); } catch { return undefined; }
  const responseLogs = entries.filter((n) => n.endsWith("-response.log"));
  for (const name of responseLogs.slice(0, 5)) {
    try {
      const txt = await readFile(join(logsDir, name), "utf8");
      const m = txt.match(/--model\s+(\S+)/);
      if (m) return m[1].replace(/["']/g, "");
    } catch { /* try next */ }
  }
  return undefined;
}

/**
 * Mutates `meta` to include backfilled fields (currently: model). Safe to
 * call regardless of whether meta already exists.
 */
export async function backfillMeta(runDir: string, results: any): Promise<void> {
  if (!results || typeof results !== "object") return;
  if (!results.meta) results.meta = {};
  if (!results.meta.model) {
    const m = await inferModelFromLogs(runDir);
    if (m) {
      results.meta.model = m;
      results.meta.modelInferred = true;
    }
  }
}
