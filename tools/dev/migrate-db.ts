#!/usr/bin/env tsx
/** Apply committed migrations and surface the exact file and PostgreSQL failure. */
import path from "node:path";
import { resolveDatabaseAdminTarget } from "./lib/dev-db-target";
import { resolveCurrentRepoRoot } from "./lib/dev-env";
import { formatMigrationFailure, runMigrations } from "./lib/migration-runner";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoRoot = resolveCurrentRepoRoot();
  const target = resolveDatabaseAdminTarget({ repoRoot, args });

  const migrationsDirectory = path.join(repoRoot, "packages/database/src/migrations");
  try {
    await runMigrations({ databaseUrl: target.databaseUrl, migrationsDirectory });
    console.log(`db:migrate: applied migrations to "${target.databaseName}"`);
  } catch (error) {
    console.error(formatMigrationFailure(error, { repoRoot }));
    process.exitCode = 1;
    return;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `db:migrate: ${error.message}` : String(error));
  process.exitCode = 1;
});
