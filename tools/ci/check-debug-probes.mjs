#!/usr/bin/env node
/**
 * Blocks temporary console probes from product source before push.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SEARCH_ROOTS = ["apps/app/src", "apps/server/server", "packages"];
const PATTERNS = [/TEMP-DEBUG/, /\[temp-debug:/, /console\.log\(/, /console\.debug\(/];
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const EXCLUDED_PARTS = new Set([
  "node_modules",
  "dist",
  ".output",
  "__tests__",
  "scripts",
  "demo",
  "e2e",
]);
const EXCLUDED_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".bench.test.ts"];

function hasExcludedPart(filePath) {
  const parts = filePath.split(path.sep);
  return parts.some((part) => EXCLUDED_PARTS.has(part));
}

function shouldSkipFile(filePath) {
  if (hasExcludedPart(filePath)) return true;
  if (EXCLUDED_SUFFIXES.some((suffix) => filePath.endsWith(suffix))) return true;
  return !SOURCE_EXTENSIONS.has(path.extname(filePath));
}

function walk(root) {
  if (hasExcludedPart(root)) return [];
  const stats = lstatSync(root, { throwIfNoEntry: false });
  if (!stats || stats.isSymbolicLink()) return [];
  if (stats.isFile()) return shouldSkipFile(root) ? [] : [root];
  if (!stats.isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(root)) {
    files.push(...walk(path.join(root, entry)));
  }
  return files;
}

const findings = [];

for (const filePath of SEARCH_ROOTS.flatMap(walk)) {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (PATTERNS.some((pattern) => pattern.test(line))) {
      findings.push(`${filePath}:${index + 1}:${line}`);
    }
  }
}

if (findings.length === 0) {
  process.exit(0);
}

console.error("Temporary console/debug statements remain in product source.");
console.error("");
console.error(
  "Delete them before pushing, or convert useful signals into durable observability via EventSink / agent debug trace capture.",
);
console.error("");
console.error("Allowed temporary form while diagnosing:");
console.error("  // TEMP-DEBUG: remove before push");
console.error('  console.log("[temp-debug:<area>]", { ...safeMetadata });');
console.error("");
console.error("Matches:");
console.error(findings.join("\n"));
process.exit(1);
