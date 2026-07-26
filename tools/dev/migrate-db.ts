#!/usr/bin/env tsx
/** Apply committed migrations and surface the exact file and PostgreSQL failure. */
import path from "node:path";
import { applyDevEnvToProcess, resolveCurrentRepoRoot } from "./lib/dev-env";
import { formatMigrationFailure, runMigrations } from "./lib/migration-runner";

const USE_AMBIENT_DATABASE_URL = "--use-ambient-database-url";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter((arg) => arg !== USE_AMBIENT_DATABASE_URL);
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown db:migrate argument(s): ${unknownArgs.join(", ")}`);
  }

  const repoRoot = resolveCurrentRepoRoot();
  if (!args.includes(USE_AMBIENT_DATABASE_URL)) {
    applyDevEnvToProcess(repoRoot);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const migrationsDirectory = path.join(repoRoot, "packages/database/src/migrations");
  try {
    await runMigrations({ databaseUrl, migrationsDirectory });
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
    console.log(`db:migrate: applied migrations to "${databaseName}"`);
  } catch (error) {
    console.error(formatMigrationFailure(error, { migrationsDirectory, repoRoot }));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `db:migrate: ${error.message}` : String(error));
  process.exitCode = 1;
});
