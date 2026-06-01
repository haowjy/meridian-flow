import { execSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

/** Print env vars from `supabase status` for copying into .env */
function main(): void {
  try {
    execSync("supabase status -o env", {
      cwd: repoRoot,
      stdio: "inherit",
    });
    console.log("\n# Map into .env (see .env.example):");
    console.log("#   API_URL              → SUPABASE_URL");
    console.log("#   ANON_KEY             → SUPABASE_ANON_KEY");
    console.log("#   SERVICE_ROLE_KEY     → SUPABASE_SERVICE_ROLE_KEY");
    console.log("#   DB_URL               → DATABASE_URL");
    console.log("TEST_USER_EMAIL=test@meridian.dev");
    console.log("TEST_USER_PASSWORD=meridian-dev");
  } catch {
    console.error("Run `pnpm supabase:start` first, then retry.");
    process.exit(1);
  }
}

main();
