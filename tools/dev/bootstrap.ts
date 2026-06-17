import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { loadRepoEnv } from "./load-env.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
loadRepoEnv(repoRoot);

const NEXT_STEP = "Next: log in via dev-login; identity is provisioned on first sign-in";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.log(
      "bootstrap: DATABASE_URL not set — skip DB migrate/apply-functions (add to .env after pnpm supabase:env)",
    );
    console.log(`\n${NEXT_STEP}`);
    return;
  }

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
