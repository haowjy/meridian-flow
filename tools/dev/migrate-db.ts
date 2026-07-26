#!/usr/bin/env tsx
/** Apply committed migrations and surface the exact file and PostgreSQL failure. */
import path from "node:path";
import { isLocalDevPostgres } from "./lib/dev-db";
import {
  applyDevEnvToProcess,
  resolveCurrentRepoRoot,
  resolveMainDatabaseNames,
} from "./lib/dev-env";
import { formatMigrationFailure, runMigrations } from "./lib/migration-runner";
import { isProcessAlive, managedTestDatabaseOwnerPid } from "./lib/test-db-lifecycle";

const ALLOW_MAIN_DATABASE = "--allow-main-database";
const MANAGED_TEST_DATABASE = "--managed-test-database";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const knownArgs = new Set([ALLOW_MAIN_DATABASE, MANAGED_TEST_DATABASE]);
  const unknownArgs = args.filter((arg) => !knownArgs.has(arg));
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown db:migrate argument(s): ${unknownArgs.join(", ")}`);
  }
  if (args.includes(ALLOW_MAIN_DATABASE) && args.includes(MANAGED_TEST_DATABASE)) {
    throw new Error(`${ALLOW_MAIN_DATABASE} and ${MANAGED_TEST_DATABASE} cannot be combined`);
  }

  const repoRoot = resolveCurrentRepoRoot();
  const mainDatabaseNames = resolveMainDatabaseNames(repoRoot);
  if (!args.includes(MANAGED_TEST_DATABASE)) {
    applyDevEnvToProcess(repoRoot);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (!databaseName) {
    throw new Error("DATABASE_URL has no database name");
  }

  if (args.includes(MANAGED_TEST_DATABASE)) {
    const ownerPid = managedTestDatabaseOwnerPid(databaseName, mainDatabaseNames);
    if (!isLocalDevPostgres(databaseUrl) || ownerPid === undefined || !isProcessAlive(ownerPid)) {
      throw new Error(
        `${MANAGED_TEST_DATABASE} requires an active, locally managed disposable database`,
      );
    }
  } else if (mainDatabaseNames.includes(databaseName) && !args.includes(ALLOW_MAIN_DATABASE)) {
    throw new Error(
      `Refusing to migrate registered main database "${databaseName}". ` +
        `Re-run with ${ALLOW_MAIN_DATABASE} only when this is intentional.`,
    );
  }

  const migrationsDirectory = path.join(repoRoot, "packages/database/src/migrations");
  try {
    await runMigrations({ databaseUrl, migrationsDirectory });
    console.log(`db:migrate: applied migrations to "${databaseName}"`);
  } catch (error) {
    console.error(formatMigrationFailure(error, { repoRoot }));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `db:migrate: ${error.message}` : String(error));
  process.exitCode = 1;
});
