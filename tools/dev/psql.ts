#!/usr/bin/env tsx
/**
 * `pnpm db:psql [psql args…]`: run `psql` against this checkout's database.
 * Env is loaded for this process only, so nothing is exported into the shell
 * (psql ignores `DATABASE_URL` anyway) and no provider or WorkOS key is exposed.
 */
import { spawnSync } from "node:child_process";
import { applyDevEnvToProcess } from "./lib/dev-env";

applyDevEnvToProcess();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("db:psql: DATABASE_URL is not set in the main .env or this checkout's .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);
const result = spawnSync(
  "psql",
  ["-w", databaseUrl, ...(args[0] === "--" ? args.slice(1) : args)],
  {
    stdio: "inherit",
  },
);
if (result.error) {
  console.error(`db:psql: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
