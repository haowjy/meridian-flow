import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { loadRepoEnv, requireEnv } from "./load-env.ts";
import { seedDevProject } from "./seed-dev-project.ts";
import { seedDevUser } from "./seed-dev-user.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
loadRepoEnv(repoRoot);

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const externalId = requireEnv("WORKOS_DEV_LOGIN_USER_ID");
  const email =
    process.env.WORKOS_DEV_LOGIN_EMAIL?.trim() ||
    process.env.TEST_USER_EMAIL?.trim() ||
    "test@meridian.dev";

  if (!databaseUrl) {
    console.log(
      "bootstrap: DATABASE_URL not set — skip DB migrate/seed (add to .env after pnpm supabase:env)",
    );
    console.log("\nNext: pnpm dev");
    return;
  }

  console.log("bootstrap: running db:migrate…");
  execSync("pnpm db:migrate", { cwd: repoRoot, stdio: "inherit" });
  console.log("bootstrap: running db:apply-functions…");
  execSync("pnpm --filter @meridian/database db:apply-functions", {
    cwd: repoRoot,
    stdio: "inherit",
  });

  console.log("bootstrap: seeding dev public.users…");
  const userId = await seedDevUser({ databaseUrl, externalId, email });
  console.log(`  email:       ${email}`);
  console.log(`  external_id: ${externalId}`);
  console.log(`  id:          ${userId}`);

  const projectId = await seedDevProject(databaseUrl, userId);
  if (projectId) {
    console.log(`bootstrap: sample project ready (${projectId}) with fs + kb context sources`);
  }

  console.log("\nDone. Internal user id for scripts/tests:");
  console.log(`  TEST_USER_ID=${userId}`);
  console.log("\nNext: pnpm dev");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
