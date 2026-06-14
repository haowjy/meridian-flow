#!/usr/bin/env tsx
import { ensureDatabaseForUrl, formatPgError } from "./lib/dev-db";
import { applyDevEnvToProcess, DEV_DATABASES } from "./lib/dev-env";

async function main(): Promise<void> {
  applyDevEnvToProcess();
  let checkedAny = false;
  for (const { envVar, label } of DEV_DATABASES) {
    const dbUrl = process.env[envVar];
    if (!dbUrl) continue;
    checkedAny = true;
    const { targetDb } = await ensureDatabaseForUrl(dbUrl);
    console.log(`▸ ${label} database "${targetDb}" reachable`);
  }
  if (!checkedAny) throw new Error("No dev database URLs are set (expected DATABASE_URL)");
}

main().catch((err: unknown) => {
  console.error("✗ ensure-db failed:", formatPgError(err));
  process.exit(1);
});
