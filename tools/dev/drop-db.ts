#!/usr/bin/env tsx
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { dropDatabaseForUrl, formatPgError, parseTargetDatabase } from "./lib/dev-db";
import {
  applyDevEnvToProcess,
  DEV_DATABASES,
  resolveCurrentRepoRoot,
  resolveMainDatabaseNames,
} from "./lib/dev-env";

async function confirmDrop(targetDb: string, yes: boolean): Promise<void> {
  if (yes) return;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`Drop database "${targetDb}"? This cannot be undone. [y/N] `);
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
  const mainDbNames = resolveMainDatabaseNames(repoRoot);
  let droppedAny = false;

  for (const { envVar, label } of DEV_DATABASES) {
    const dbUrl = process.env[envVar];
    if (!dbUrl) continue;
    const { targetDb } = parseTargetDatabase(dbUrl);
    await confirmDrop(targetDb, yes);
    const { targetDb: droppedDb } = await dropDatabaseForUrl(dbUrl, mainDbNames);
    console.log(`▸ ${label} database "${droppedDb}" dropped`);
    droppedAny = true;
  }

  if (!droppedAny) throw new Error("No dev database URLs are set (expected DATABASE_URL)");
}

main().catch((err: unknown) => {
  console.error("✗ drop-db failed:", formatPgError(err));
  process.exit(1);
});
