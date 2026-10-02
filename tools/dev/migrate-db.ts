#!/usr/bin/env tsx
/** Apply committed migrations and canonical functions through the package-owned runner. */
import path from "node:path";
import {
  DatabaseHistoryRefusalError,
  formatMigrationFailure,
  runMigrations,
} from "@meridian/database/release";
import { isLocalDevPostgres } from "./lib/dev-db";
import { resolveDatabaseAdminTarget } from "./lib/dev-db-target";
import { resolveCurrentRepoRoot } from "./lib/dev-env";
import { formatDatabaseHistoryRefusal } from "./lib/migration-history";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoRoot = resolveCurrentRepoRoot();
  const target = resolveDatabaseAdminTarget({ repoRoot, args });
  const migrationsDirectory = path.join(repoRoot, "packages/database/src/migrations");

  try {
    await runMigrations({ databaseUrl: target.databaseUrl, migrationsDirectory });
    console.log(`db:migrate: applied migrations and functions to "${target.databaseName}"`);
  } catch (error) {
    if (error instanceof DatabaseHistoryRefusalError) {
      console.error(
        formatDatabaseHistoryRefusal({
          databaseName: target.databaseName,
          issues: error.issues,
          localDevDatabase: isLocalDevPostgres(target.databaseUrl),
        }),
      );
    } else {
      console.error(formatMigrationFailure(error));
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `db:migrate: ${error.message}` : String(error));
  process.exitCode = 1;
});
