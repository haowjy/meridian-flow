#!/usr/bin/env node
/**
 * Fails when the committed locale catalogs no longer match the source.
 *
 * Writer-facing copy reaches the browser through the COMPILED catalogs
 * (`messages.ts`), not the `.po` files. A `t` macro added without running
 * extract and compile therefore ships as a raw message id — "9vVTAg" where a
 * sentence should be — and nothing else in the toolchain notices. This runs
 * both generators over the working tree, formats their output the way the
 * commit hook does, and reports any file they would change — restoring the
 * tree either way so the check has no side effects.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appDir = join(repoRoot, "apps/app");
const compiledCatalogs = ["en", "zh"].map((locale) =>
  join(appDir, `src/locales/${locale}/messages.ts`),
);
const catalogs = [
  ...["en", "zh"].map((locale) => join(appDir, `src/locales/${locale}/messages.po`)),
  ...compiledCatalogs,
];

const before = new Map(catalogs.map((path) => [path, readFileSync(path, "utf8")]));

function runLingui(command) {
  execFileSync("pnpm", ["exec", "lingui", command], {
    cwd: appDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function formatCompiledCatalogs() {
  // `lingui compile` emits one long line; the commit hook reformats it, so the
  // committed file is the formatted one and only that comparison is fair.
  execFileSync("pnpm", ["exec", "biome", "check", "--write", ...compiledCatalogs], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

let drifted = [];
try {
  runLingui("extract");
  runLingui("compile");
  formatCompiledCatalogs();
  drifted = catalogs.filter((path) => readFileSync(path, "utf8") !== before.get(path));
} finally {
  for (const [path, contents] of before) {
    if (readFileSync(path, "utf8") !== contents) writeFileSync(path, contents);
  }
}

if (drifted.length > 0) {
  console.error("ERROR: locale catalogs are out of date with the source:");
  for (const path of drifted) console.error(`  ${relative(repoRoot, path)}`);
  console.error(
    "\nRun: pnpm --filter @meridian/app lingui:extract && pnpm --filter @meridian/app lingui:compile",
  );
  console.error("then commit the catalogs with the copy change.");
  process.exit(1);
}

console.log("Locale catalogs are current.");
