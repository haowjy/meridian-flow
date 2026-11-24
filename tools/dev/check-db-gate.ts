#!/usr/bin/env bun

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { relative } from "node:path";
import { parseTargetDatabase, pingDatabaseForUrl } from "./lib/dev-db";
import { applyDevEnvToProcess, resolveCurrentRepoRoot } from "./lib/dev-env";

const CHANGE_BASE = "origin/main";
const DB_TEST_CONFIG = "apps/server/vitest.db.config.ts";
const SELECTION_DATABASE_URL = "postgresql://db-gate-selection@127.0.0.1:1/db_gate_test_selection";

const DB_TEST_INFRASTRUCTURE_FILES = new Set([
  DB_TEST_CONFIG,
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tools/ci/db-test-reporter.ts",
  "tools/ci/db-test-worker-setup.ts",
  "tools/ci/test-budget-reporter.ts",
  "tools/ci/test-case-baseline.json",
  "tools/dev/cleanup-test-databases.ts",
  "tools/dev/lib/dev-db-target.ts",
  "tools/dev/lib/dev-db.ts",
  "tools/dev/lib/dev-env.ts",
  "tools/dev/lib/migration-runner.ts",
  "tools/dev/lib/test-db-lifecycle.ts",
  "tools/dev/migrate-db.ts",
  "tools/dev/run-db-tests.ts",
]);

function gitPaths(repoRoot: string, args: string[]): string[] {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `git exited with status ${result.status}`;
    throw new Error(
      `db-gate: could not determine changes from ${CHANGE_BASE}: ${detail}. ` +
        "Run `DB_GATE_FULL=1 pnpm check:db` to bypass change selection.",
    );
  }
  return result.stdout.split("\0").filter(Boolean);
}

function changedPaths(repoRoot: string): string[] {
  return [
    ...gitPaths(repoRoot, ["diff", "--name-only", "-z", `${CHANGE_BASE}...HEAD`]),
    ...gitPaths(repoRoot, ["diff", "--cached", "--name-only", "-z"]),
    ...gitPaths(repoRoot, ["ls-files", "--modified", "--others", "--exclude-standard", "-z"]),
  ].filter((path, index, paths) => paths.indexOf(path) === index);
}

function fullSuiteReason(paths: readonly string[]): string | undefined {
  const infrastructurePath = paths.find(
    (path) =>
      path.startsWith("apps/server/server/test-support/") ||
      path.startsWith("packages/database/") ||
      DB_TEST_INFRASTRUCTURE_FILES.has(path),
  );
  return infrastructurePath ? `DB test infrastructure changed (${infrastructurePath})` : undefined;
}

async function pings(url: string): Promise<boolean> {
  try {
    await pingDatabaseForUrl(url);
    return true;
  } catch {
    return false;
  }
}

async function isReachable(databaseUrl: string): Promise<boolean> {
  if (await pings(databaseUrl)) return true;
  try {
    return await pings(parseTargetDatabase(databaseUrl).adminConnString);
  } catch {
    return false;
  }
}

function runTestDb(repoRoot: string, testFiles: readonly string[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("pnpm", ["test:db", ...testFiles], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`pnpm test:db exited on ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function selectRelatedDbTests(repoRoot: string): string[] {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "list",
      "--config",
      DB_TEST_CONFIG,
      "--changed",
      CHANGE_BASE,
      "--filesOnly",
      "--json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: SELECTION_DATABASE_URL,
        RUN_DB_TESTS: "1",
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `db-gate: Vitest could not select tests related to changes since ${CHANGE_BASE}: ${detail}`,
    );
  }

  const selected = JSON.parse(result.stdout) as unknown;
  if (
    !Array.isArray(selected) ||
    !selected.every(
      (value): value is { file: string } =>
        typeof value === "object" &&
        value !== null &&
        "file" in value &&
        typeof value.file === "string",
    )
  ) {
    throw new Error("db-gate: Vitest returned an invalid related-test list.");
  }
  return selected.map(({ file }) => relative(repoRoot, file));
}

async function main(): Promise<void> {
  const repoRoot = resolveCurrentRepoRoot();
  applyDevEnvToProcess(repoRoot);

  const runFullReason =
    process.env.DB_GATE_FULL === "1" ? "DB_GATE_FULL=1" : fullSuiteReason(changedPaths(repoRoot));
  const testFiles = runFullReason ? [] : selectRelatedDbTests(repoRoot);

  if (!runFullReason && testFiles.length === 0) {
    console.log(
      `db-gate: skipped — no DB test files are related to changes since ${CHANGE_BASE} ` +
        "(including staged, unstaged, and untracked files).",
    );
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "db-gate: failed — DATABASE_URL is not set, so the related DB tests cannot run. " +
        "Start Postgres with `pnpm dev:infra` and set DATABASE_URL in .env, then run `pnpm check` again.",
    );
    process.exitCode = 1;
    return;
  }

  if (!(await isReachable(databaseUrl))) {
    console.error(
      "db-gate: failed — Postgres is not reachable at the configured DATABASE_URL, so the " +
        "related DB tests cannot run. Run `pnpm dev:infra` to start it, then run `pnpm check` again.",
    );
    process.exitCode = 1;
    return;
  }

  if (runFullReason) {
    console.log(`db-gate: Postgres reachable — running the full DB suite: ${runFullReason}.`);
  } else {
    console.log(
      `db-gate: Postgres reachable — running ${testFiles.length} related DB test ${testFiles.length === 1 ? "file" : "files"}:`,
    );
    for (const testFile of testFiles) console.log(`  ${testFile}`);
  }
  process.exitCode = await runTestDb(repoRoot, testFiles);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
