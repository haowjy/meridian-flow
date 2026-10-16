#!/usr/bin/env tsx
/**
 * Local DB gate — runs only the Postgres-backed test files related to changes
 * since origin/main, including staged, unstaged, and untracked files.
 *
 * Vitest resolves related tests through its module graph. Changes that the
 * graph cannot model safely (DB config, migrations, test support, DB-test
 * lifecycle helpers, and dependency resolution) run the full suite, as does
 * DB_GATE_FULL=1. A missing or unreachable local database and a change with no
 * related DB tests skip loudly.
 * CI's db-tests job and `pnpm test:db` always run the full suite.
 *
 *   pnpm check:db
 *   DB_GATE_FULL=1 pnpm check:db
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { relative } from "node:path";
import { parseTargetDatabase, pingDatabaseForUrl } from "./lib/dev-db";
import { applyDevEnvToProcess, resolveCurrentRepoRoot } from "./lib/dev-env";

const CHANGE_BASE = "origin/main";
const DB_TEST_CONFIG = "apps/server/vitest.db.config.ts";
// The DB config rejects ordinary dev databases at load time. `vitest list`
// builds the module graph without connecting, so give it an unmistakably
// disposable, unreachable URL and provision a real owned DB only after a match.
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
  "tools/dev/lib/migration-history.ts",
  "tools/dev/lib/migration-runner.ts",
  "tools/dev/lib/migration-sql.ts",
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

/**
 * Reachable means the Postgres *server* is up, not that this checkout's own
 * database exists: `pnpm test:db` creates its own managed test database. So try
 * the configured URL first (fast path), then fall back to the server-level
 * maintenance connection so a not-yet-bootstrapped worktree still runs the gate.
 */
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
    console.warn(
      "db-gate: skipped — DATABASE_URL is not set. Start Postgres with `pnpm dev:infra` and set it in .env to run the gate locally; CI runs the full suite in the db-tests job.",
    );
    return;
  }

  if (!(await isReachable(databaseUrl))) {
    console.warn(
      "db-gate: skipped — Postgres is not reachable at the configured DATABASE_URL. Run `pnpm dev:infra` to start it. Force the gate with `pnpm test:db`.",
    );
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
