#!/usr/bin/env tsx
/** Check that committed migration history is frozen and newly appended migrations are ordered. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  buildMigrationHistory,
  compareRepositoryMigrationHistory,
  readMigrationHistory,
} from "./lib/migration-history";

const MIGRATIONS_PATH = "packages/database/src/migrations";

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) {
    throw new Error(`Usage: pnpm db:migration-history -- --base <git-ref>`);
  }
  return value;
}

function git(repoRoot: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "buffer" });
}

function readHistoryAtRef(repoRoot: string, ref: string) {
  const journalText = git(repoRoot, [
    "show",
    `${ref}:${MIGRATIONS_PATH}/meta/_journal.json`,
  ]).toString("utf8");
  const files = git(repoRoot, ["ls-tree", "-r", "--name-only", ref, "--", MIGRATIONS_PATH])
    .toString("utf8")
    .split("\n")
    .filter((file) => file.endsWith(".sql"));
  const sqlFiles = new Map<string, Buffer>();
  for (const file of files) {
    sqlFiles.set(path.basename(file), git(repoRoot, ["show", `${ref}:${file}`]));
  }
  return buildMigrationHistory({ journalText, sqlFiles });
}

function main(): void {
  const baseRef = argumentValue("--base");
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const base = readHistoryAtRef(repoRoot, baseRef);
  const head = readMigrationHistory(path.join(repoRoot, MIGRATIONS_PATH));
  const issues = compareRepositoryMigrationHistory(base, head);
  if (issues.length === 0) {
    console.log(`db:migration-history: migration history is append-only after ${baseRef}`);
    return;
  }

  const baseTip = base.entries.at(-1)?.tag ?? "the base branch's last migration";
  console.error(`db:migration-history: refused changes against ${baseRef}`);
  for (const issue of issues) {
    console.error(
      `  - ${issue}. Restore merged migrations unchanged, then merge the base branch and regenerate this branch's migrations with \`pnpm db:generate\` so they come after ${baseTip}.`,
    );
  }
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`db:migration-history: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
