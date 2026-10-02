#!/usr/bin/env tsx
/** Run the shared DB suite against a database owned by this invocation. */
import { execFile, fork, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { acquireDatabaseTestAdmission } from "./lib/db-test-admission";
import { effectiveDbTestWorkerCount, parseDbTestWorkerCount } from "./lib/db-test-workers";
import { cloneDatabaseForUrl, ensureDatabaseForUrl, isLocalDevPostgres } from "./lib/dev-db";
import { resolveCurrentRepoRoot, resolveMainDatabaseNames } from "./lib/dev-env";
import { managedTestDatabaseUrl, managedTestDatabaseWorkerUrl } from "./lib/test-db-lifecycle";

const execFileAsync = promisify(execFile);

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

async function countSelectedSuites(
  repoRoot: string,
  testArgs: readonly string[],
  databaseUrl: string,
): Promise<number> {
  const { stdout } = await execFileAsync(
    "pnpm",
    [
      "exec",
      "vitest",
      "list",
      "--config",
      "apps/server/vitest.db.config.ts",
      "--filesOnly",
      ...testArgs,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        RUN_DB_TESTS: "1",
        TEST_DB_ALLOW_DESTRUCTIVE: "1",
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return stdout.split("\n").filter((line) => line.startsWith("[db] ")).length;
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
  const testArgs = process.argv.slice(2);
  if (testArgs[0] === "--") testArgs.shift();
  const configuredWorkerCount = parseDbTestWorkerCount(process.env.DB_TEST_WORKERS);
  const admission = local
    ? await acquireDatabaseTestAdmission(sourceDatabaseUrl, configuredWorkerCount)
    : undefined;
  let workerDatabaseUrls: string[] = [];

  try {
    const selectedSuiteCount = await countSelectedSuites(repoRoot, testArgs, databaseUrl);
    const workerCount = effectiveDbTestWorkerCount(
      Math.min(configuredWorkerCount, admission?.workerBudget ?? configuredWorkerCount),
      selectedSuiteCount,
    );
    console.log(
      `DB tests: ${selectedSuiteCount} suite(s) selected; using ${workerCount} of ${configuredWorkerCount} configured worker(s).`,
    );
    workerDatabaseUrls = local
      ? Array.from({ length: workerCount }, (_, index) =>
          managedTestDatabaseWorkerUrl(databaseUrl, index + 1),
        )
      : [];
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
      ["exec", "vitest", "run", "--config", "apps/server/vitest.db.config.ts", ...testArgs],
      databaseUrl,
      workerDatabaseUrls.length > 0
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
            DB_TEST_WORKERS: String(workerCount),
          }
        : {},
    );
    process.exitCode = testExit;
  } finally {
    try {
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
    } finally {
      await admission?.release();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
