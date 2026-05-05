import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalRunResults } from "./types.js";
import { backfillMeta } from "./inferMeta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, "..", "templates", "dashboard.html");

/**
 * Generate an HTML dashboard with the run data inlined as a <script> block.
 * Inlining lets the report work when opened directly via file:// (browsers
 * block fetch() against file:// URLs). The fetch() fallback in the template
 * still works when served over HTTP.
 */
export async function generateDashboard(
  outputDir: string,
  filename: string,
  results: EvalRunResults,
): Promise<string> {
  const filePath = join(outputDir, filename);
  await backfillMeta(outputDir, results);
  const template = await readFile(TEMPLATE_PATH, "utf8");
  const json = JSON.stringify(results).replace(/<\/script/gi, "<\\/script");
  const inlined = template.replace(
    "</head>",
    `<script id="eval-data" type="application/json">${json}</script>\n</head>`,
  );
  await writeFile(filePath, inlined);
  return filePath;
}
