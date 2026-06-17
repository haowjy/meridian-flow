#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { ensureDatabaseForUrl, ensureExtensionsForUrl, formatPgError } from "./lib/dev-db";
import { applyDevEnvToProcess, DEV_DATABASES, resolveCurrentRepoRoot } from "./lib/dev-env";

async function main(): Promise<void> {
  applyDevEnvToProcess();
  const repoRoot = resolveCurrentRepoRoot();
  const active = DEV_DATABASES.map((db) => ({ db, dbUrl: process.env[db.envVar] })).filter(
    (entry): entry is { db: (typeof DEV_DATABASES)[number]; dbUrl: string } => Boolean(entry.dbUrl),
  );
  if (active.length === 0) throw new Error("No dev database URLs are set (expected DATABASE_URL)");

  for (const { db, dbUrl } of active) {
    const { targetDb, created } = await ensureDatabaseForUrl(dbUrl);
    console.log(`▸ ${db.label} database "${targetDb}" ${created ? "created" : "ready"}`);
    if (db.extensions?.length) {
      await ensureExtensionsForUrl(dbUrl, db.extensions);
      console.log(`▸ ${db.label} extensions ready: ${db.extensions.join(", ")}`);
    }
    console.log(`▸ Migrating ${db.label}`);
    execFileSync(db.migrateScript, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true,
      env: process.env,
    });
    if (db.postMigrateScript) {
      console.log(`▸ Applying post-migrate SQL for ${db.label}`);
      execFileSync(db.postMigrateScript, {
        cwd: repoRoot,
        stdio: "inherit",
        shell: true,
        env: process.env,
      });
    }
  }
}

main().catch((err: unknown) => {
  console.error("✗ prepare-db failed:", formatPgError(err));
  process.exit(1);
});
