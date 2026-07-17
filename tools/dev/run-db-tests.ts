#!/usr/bin/env tsx
/** Run the shared DB suite against a database owned by this invocation. */
import { spawn } from "node:child_process";
import { dropDatabaseForUrl, ensureDatabaseForUrl, isLocalDevPostgres } from "./lib/dev-db";
import { resolveCurrentRepoRoot, resolveMainDatabaseNames } from "./lib/dev-env";
import { managedTestDatabaseUrl } from "./lib/test-db-lifecycle";

function run(repoRoot: string, args: string[], databaseUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        RUN_DB_TESTS: "1",
        TEST_DB_ALLOW_DESTRUCTIVE: "1",
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
  const testArgs = process.argv.slice(2);
  if (testArgs[0] === "--") testArgs.shift();

  try {
    if (local) {
      const { targetDb } = await ensureDatabaseForUrl(databaseUrl);
      console.log(`DB tests: created owned database ${targetDb}.`);
      const migrationExit = await run(repoRoot, ["db:migrate"], databaseUrl);
      if (migrationExit !== 0)
        throw new Error(`DB migrations exited with status ${migrationExit}.`);
      const functionsExit = await run(repoRoot, ["db:apply-functions"], databaseUrl);
      if (functionsExit !== 0) {
        throw new Error(`DB function installation exited with status ${functionsExit}.`);
      }
    }

    const testExit = await run(
      repoRoot,
      ["exec", "vitest", "run", "--config", "apps/server/vitest.db.config.ts", ...testArgs],
      databaseUrl,
    );
    process.exitCode = testExit;
  } finally {
    if (local) {
      const result = await dropDatabaseForUrl(databaseUrl, mainDatabaseNames);
      console.log(`DB tests: dropped owned database ${result.targetDb}.`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
