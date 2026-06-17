#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { formatPgError, parseTargetDatabase, resetSchemaForUrl } from "./lib/dev-db";
import { applyDevEnvToProcess, DEV_DATABASES, resolveCurrentRepoRoot } from "./lib/dev-env";
import { ensureDevInfraUp } from "./lib/dev-infra";

async function confirmReset(targetDb: string, yes: boolean): Promise<void> {
  if (yes) return;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Reset schema in database "${targetDb}"? All data will be lost. [y/N] `,
    );
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Aborted.");
      process.exit(0);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  applyDevEnvToProcess();
  const yes = process.argv.includes("--yes");
  const repoRoot = resolveCurrentRepoRoot();
  const active = DEV_DATABASES.map((db) => ({ db, dbUrl: process.env[db.envVar] })).filter(
    (entry): entry is { db: (typeof DEV_DATABASES)[number]; dbUrl: string } => Boolean(entry.dbUrl),
  );
  if (active.length === 0) throw new Error("No dev database URLs are set (expected DATABASE_URL)");

  console.log("▸ Ensuring local Postgres container is up…");
  ensureDevInfraUp(repoRoot);

  for (const { db, dbUrl } of active) {
    const { targetDb } = parseTargetDatabase(dbUrl);
    await confirmReset(targetDb, yes);
    const { targetDb: resetDb } = await resetSchemaForUrl(dbUrl);
    console.log(`▸ ${db.label} schema reset in "${resetDb}"`);
  }

  console.log("▸ Preparing database (extensions + migrate + apply-functions)…");
  execFileSync("tsx", [path.join(repoRoot, "tools/dev/prepare-db.ts")], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
}

main().catch((err: unknown) => {
  console.error("✗ reset-db failed:", formatPgError(err));
  process.exit(1);
});
