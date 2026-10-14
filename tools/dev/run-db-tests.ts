#!/usr/bin/env tsx
/** Run the shared DB suite against a database owned by this invocation. */
import { fork, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { cloneDatabaseForUrl, ensureDatabaseForUrl, isLocalDevPostgres } from "./lib/dev-db";
import { resolveCurrentRepoRoot, resolveMainDatabaseNames } from "./lib/dev-env";
import { managedTestDatabaseUrl, managedTestDatabaseWorkerUrl } from "./lib/test-db-lifecycle";

function run(
  repoRoot: string,
  args: string[],
  databaseUrl: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        RUN_DB_TESTS: "1",
        TEST_DB_ALLOW_DESTRUCTIVE: "1",
        ...extraEnv,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`pnpm ${args.join(" ")} exited on ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const sourceDatabaseUrl = process.env.DATABASE_URL;
  if (!sourceDatabaseUrl) throw new Error("DB tests require DATABASE_URL.");

  const repoRoot = resolveCurrentRepoRoot();
  const mainDatabaseNames = resolveMainDatabaseNames(repoRoot);
  const local = isLocalDevPostgres(sourceDatabaseUrl);
  const mainDatabaseName = mainDatabaseNames[0];
  if (local && !mainDatabaseName) {
    throw new Error("Local DB tests require a registered main database in .env.");
  }
  let databaseUrl = sourceDatabaseUrl;
  if (local && mainDatabaseName) {
    databaseUrl = managedTestDatabaseUrl(sourceDatabaseUrl, mainDatabaseName);
  }
  const testArgs = process.argv
    .slice(2)
    .map((arg) => arg.replace(/^--reporters(?==|$)/u, "--reporter"));
  if (testArgs[0] === "--") testArgs.shift();
  const allSuites = testArgs[0] === "--all";
  if (allSuites) {
    testArgs.shift();
    if (testArgs[0] === "--") testArgs.shift();
  }
  // Local default is 4, not 8. Measured on the shared host with the identical
  // 912 cases: 8 fork workers peak at 6,038MB in 65s and flaked a settlement
  // test; 4 workers peak at 3,869MB in 91s and ran all 912 green. Fork workers
  // are whole processes, so this is the largest per-run memory knob in the repo
  // — nearly twice the unit suite's 3.1GB. Override with DB_TEST_WORKERS=1..8.
  //
  // Workers are local-only: each needs its own cloned database, and only the
  // local path provisions them. CI points DATABASE_URL at its own throwaway
  // database and gets no worker URLs, so vitest.db.config.ts falls to
  // maxWorkers 1 with fileParallelism false. The CI suite is serial, and its
  // wall clock is the sum of every test rather than a fraction of it.
  const workerCount = Number(process.env.DB_TEST_WORKERS ?? (local ? "4" : "1"));
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8) {
    throw new Error(
      "DB_TEST_WORKERS must be an integer from 1 to 8 (shared Postgres connection budget).",
    );
  }
  const workerDatabaseUrls = local
    ? Array.from({ length: workerCount }, (_, index) =>
        managedTestDatabaseWorkerUrl(databaseUrl, index + 1),
      )
    : [];
  // Test-bound against real Postgres and serial in CI, so the DB suite's wall
  // clock is the sum of every test: 322s on a CI runner against 89s at four
  // local workers. The unit suite's shared 150s default would fail every CI DB
  // run, so the DB suite carries its own. `pnpm test:all` inherits it for the
  // unit half too; that run is not part of `pnpm check`.
  const durationCeilingSeconds = process.env.TEST_DURATION_CEILING_SECONDS ?? "600";

  try {
    if (local) {
      const { targetDb } = await ensureDatabaseForUrl(databaseUrl);
      console.log(`DB tests: created owned database ${targetDb}.`);
      const migrationExit = await run(
        repoRoot,
        ["exec", "tsx", "tools/dev/migrate-db.ts", "--managed-test-database"],
        databaseUrl,
      );
      if (migrationExit !== 0)
        throw new Error(`DB migrations exited with status ${migrationExit}.`);
      await Promise.all(
        workerDatabaseUrls.map(async (workerDatabaseUrl) => {
          const { targetDb: workerDb } = await cloneDatabaseForUrl(databaseUrl, workerDatabaseUrl);
          console.log(`DB tests: cloned worker database ${workerDb}.`);
        }),
      );
    }

    const testExit = await run(
      repoRoot,
      [
        "exec",
        "vitest",
        "run",
        "--config",
        allSuites ? "vitest.config.mts" : "apps/server/vitest.db.config.ts",
        ...testArgs,
        // CLI reporters replace configured reporters, so the execution guard is unconditional.
        ...(testArgs.some((arg) => arg === "--reporter" || arg.startsWith("--reporter="))
          ? []
          : ["--reporter=default"]),
        `--reporter=${join(repoRoot, "tools/ci/test-budget-reporter.ts")}`,
        `--reporter=${join(repoRoot, "tools/ci/db-test-reporter.ts")}`,
      ],
      databaseUrl,
      {
        TEST_DURATION_CEILING_SECONDS: durationCeilingSeconds,
        ...(workerDatabaseUrls.length > 0
          ? {
              DB_TEST_DATABASE_URLS: JSON.stringify(
                workerDatabaseUrls.map((workerUrl) => {
                  const url = new URL(workerUrl);
                  // Postgres.js forwards unknown URL parameters as session startup settings.
                  // Only these owned throwaway connections sacrifice crash durability.
                  url.searchParams.set("synchronous_commit", "off");
                  return url.toString();
                }),
              ),
            }
          : {}),
      },
    );
    process.exitCode = testExit;
  } finally {
    if (local) {
      const logDirectory = join(repoRoot, ".meridian", "db-test-cleanup");
      mkdirSync(logDirectory, { recursive: true });
      const logPath = join(logDirectory, `${process.pid}.log`);
      const log = openSync(logPath, "a", 0o600);
      const cleanup = fork(join(repoRoot, "tools/dev/cleanup-test-databases.ts"), [], {
        cwd: repoRoot,
        detached: true,
        stdio: ["ignore", log, log, "ipc"],
      });
      closeSync(log);
      await new Promise<void>((resolve, reject) => {
        cleanup.once("error", reject);
        cleanup.once("exit", (code) =>
          reject(new Error(`DB cleanup exited before handoff (${code}); see ${logPath}`)),
        );
        cleanup.on("message", (message) => {
          if (message === "ready") resolve();
        });
        cleanup.send({ databaseUrl, workerCount: workerDatabaseUrls.length });
      });
      cleanup.unref();
      console.log(`DB tests: cleanup continues in PID ${cleanup.pid}; log: ${logPath}.`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
