import { execSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

/** Print local Postgres connection info from `supabase status` for copying into .env */
function main(): void {
  try {
    execSync("supabase status -o env", {
      cwd: repoRoot,
      stdio: "inherit",
    });
    console.log("\n# Map into .env (see .env.example):");
    console.log("#   DB_URL  → DATABASE_URL");
    console.log("# Auth is WorkOS AuthKit — configure WORKOS_* in .env.example.");
  } catch {
    console.error("Run `pnpm supabase:start` first, then retry.");
    process.exit(1);
  }
}

main();
