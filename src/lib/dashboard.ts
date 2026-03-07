import { copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalRunResults } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, "..", "templates", "dashboard.html");

/**
 * Generate an HTML dashboard that loads its data from the sibling JSON file.
 * The template uses fetch() to load <filename>.json at runtime.
 */
export async function generateDashboard(
  outputDir: string,
  filename: string,
  _results: EvalRunResults,
): Promise<string> {
  const filePath = join(outputDir, filename);
  await copyFile(TEMPLATE_PATH, filePath);
  return filePath;
}
