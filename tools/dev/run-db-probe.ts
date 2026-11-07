#!/usr/bin/env tsx
/**
 * Run one probe script against a migrated database owned by this invocation:
 *   pnpm probe:db <script.ts> [args...]
 * Probes measure or exercise real persistence outside the correctness gate.
 */
import { spawn } from "node:child_process";
import { dropDatabaseForUrl, ensureDatabaseForUrl, isLocalDevPostgres } from "./lib/dev-db";
import { resolveCurrentRepoRoot, resolveMainDatabaseNames } from "./lib/dev-env";
import { managedTestDatabaseUrl } from "./lib/test-db-lifecycle";

function run(repoRoot: string, args: string[], databaseUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, RUN_DB_TESTS: "1" },
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
  const [script, ...args] = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--");
  if (!script) throw new Error("Usage: pnpm probe:db <script.ts> [args...]");
  const sourceDatabaseUrl = process.env.DATABASE_URL;
  if (!sourceDatabaseUrl || !isLocalDevPostgres(sourceDatabaseUrl))
    throw new Error("DB probes require DATABASE_URL on the local dev Postgres.");
  const repoRoot = resolveCurrentRepoRoot();
  const mainDatabaseNames = resolveMainDatabaseNames(repoRoot);
  const mainDatabaseName = mainDatabaseNames[0];
  if (!mainDatabaseName) throw new Error("DB probes require a registered main database in .env.");
  const databaseUrl = managedTestDatabaseUrl(sourceDatabaseUrl, mainDatabaseName);
  try {
    const { targetDb } = await ensureDatabaseForUrl(databaseUrl);
    console.log(`DB probe: created owned database ${targetDb}.`);
    const migrated = await run(
      repoRoot,
      ["exec", "tsx", "tools/dev/migrate-db.ts", "--managed-test-database"],
      databaseUrl,
    );
    if (migrated !== 0) throw new Error(`DB migrations exited with status ${migrated}.`);
    process.exitCode = await run(repoRoot, ["exec", "tsx", script, ...args], databaseUrl);
  } finally {
    // Stale-run GC reclaims the database if this process dies before here.
    const { targetDb } = await dropDatabaseForUrl(databaseUrl, mainDatabaseNames);
    console.log(`DB probe: dropped ${targetDb}.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
