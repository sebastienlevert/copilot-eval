#!/usr/bin/env node

/**
 * Build a standalone binary using esbuild + Node Single Executable Application (SEA).
 *
 * Steps:
 *   1. Bundle all compiled JS into a single CJS file with esbuild
 *   2. Generate a SEA blob from the bundle
 *   3. Copy the Node binary and inject the blob into it
 */

import { execFileSync } from "node:child_process";
import { cpSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = "out";
const BUNDLE = join(OUT, "copilot-eval.cjs");
const SEA_CONFIG = join(OUT, "sea-config.json");
const SEA_BLOB = join(OUT, "sea-prep.blob");
const OUTPUT = join(OUT, "copilot-eval");

// 1. Bundle with esbuild (from compiled TS output)
mkdirSync(OUT, { recursive: true });
console.log("📦 Bundling with esbuild...");
execFileSync("npx", [
  "esbuild",
  "dist/cli.js",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--banner:js=#!/usr/bin/env node",
  `--outfile=${BUNDLE}`,
], { stdio: "inherit" });

// 2. Generate SEA config
writeFileSync(SEA_CONFIG, JSON.stringify({
  main: BUNDLE,
  output: SEA_BLOB,
  disableExperimentalSEAWarning: true,
}, null, 2));

// 3. Generate SEA blob
console.log("🔧 Generating SEA blob...");
execFileSync(process.execPath, [
  "--experimental-sea-config",
  SEA_CONFIG,
], { stdio: "inherit" });

// 4. Copy Node binary
console.log("📋 Copying Node binary...");
if (existsSync(OUTPUT)) unlinkSync(OUTPUT);
cpSync(process.execPath, OUTPUT);

// 5. Inject blob into binary
console.log("💉 Injecting SEA blob...");
execFileSync("npx", [
  "postject",
  OUTPUT,
  "NODE_SEA_BLOB",
  SEA_BLOB,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
], { stdio: "inherit" });

console.log(`\n✅ Binary built: ${OUTPUT}`);
