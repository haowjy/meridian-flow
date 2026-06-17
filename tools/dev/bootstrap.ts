import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { ensureDatabaseForUrl, ensureExtensionsForUrl } from "./lib/dev-db.ts";
import { DEV_DATABASES } from "./lib/dev-env.ts";
import { ensureDevInfraUp } from "./lib/dev-infra.ts";
import { loadRepoEnv } from "./load-env.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
loadRepoEnv(repoRoot);

const NEXT_STEP = "Next: log in via dev-login; identity is provisioned on first sign-in";

async function ensureDevDatabaseReady(): Promise<void> {
  for (const db of DEV_DATABASES) {
    const databaseUrl = process.env[db.envVar];
    if (!databaseUrl) continue;
    const { targetDb, created } = await ensureDatabaseForUrl(databaseUrl);
    console.log(`bootstrap: ${db.label} database "${targetDb}" ${created ? "created" : "ready"}`);
    if (db.extensions?.length) {
      await ensureExtensionsForUrl(databaseUrl, db.extensions);
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.log(
      "bootstrap: DATABASE_URL not set — skip DB migrate/apply-functions (set DATABASE_URL in .env after pnpm dev:infra)",
    );
    console.log(`\n${NEXT_STEP}`);
    return;
  }

  console.log("bootstrap: ensuring local Postgres container is up…");
  ensureDevInfraUp(repoRoot);
  await ensureDevDatabaseReady();

  console.log("bootstrap: running db:migrate…");
  execSync("pnpm db:migrate", { cwd: repoRoot, stdio: "inherit" });
  console.log("bootstrap: running db:apply-functions…");
  execSync("pnpm --filter @meridian/database db:apply-functions", {
    cwd: repoRoot,
    stdio: "inherit",
  });

  console.log(`\nDone.\n${NEXT_STEP}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
