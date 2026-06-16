import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { loadRepoEnv, requireEnv } from "./load-env.ts";
import { seedDevProject } from "./seed-dev-project.ts";
import { SupabaseAdminClient, signInWithPassword } from "./supabase-admin.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
loadRepoEnv(repoRoot);

/**
 * Resolve the dev auth user id idempotently. GoTrue's admin-list API does not
 * surface users seeded directly into auth.users, so fall back to an
 * authoritative SELECT before creating (which would hit the unique-email
 * constraint). Always reset the password so dev-login / e2e auth works
 * regardless of how the row was originally created.
 */
async function ensureDevUser(
  admin: SupabaseAdminClient,
  email: string,
  password: string,
  databaseUrl: string | undefined,
): Promise<string> {
  let userId = await admin.getUserIdByEmail(email);
  if (!userId && databaseUrl) {
    const { default: postgres } = await import("postgres");
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const rows = await sql<{ id: string }[]>`
        SELECT id::text AS id FROM auth.users WHERE email = ${email} LIMIT 1
      `;
      userId = rows[0]?.id ?? null;
    } finally {
      await sql.end();
    }
  }
  if (userId) {
    // Best-effort: a row seeded directly into auth.users (outside GoTrue) can be
    // unmanageable by the admin API (404) even though it blocks createUser via
    // the unique-email constraint. Don't crash bootstrap over a stale dev row —
    // warn and continue; the rest of bootstrap (migrate/seed) still runs.
    try {
      await admin.updateUserPassword(userId, password);
    } catch (err) {
      console.warn(
        `bootstrap: could not reset dev user password (${err instanceof Error ? err.message : String(err)}). ` +
          "If dev-login fails, the auth.users row may be unmanaged by GoTrue.",
      );
    }
    return userId;
  }
  return admin.createUser(email, password);
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = requireEnv("SUPABASE_ANON_KEY");

  const email = process.env.TEST_USER_EMAIL ?? "test@meridian.dev";
  const password = process.env.TEST_USER_PASSWORD ?? "meridian-dev";

  console.log("bootstrap: ensuring dev user in auth.users…");
  const admin = new SupabaseAdminClient(supabaseUrl, serviceKey);
  const userId =
    process.env.TEST_USER_ID?.trim() ||
    (await ensureDevUser(admin, email, password, process.env.DATABASE_URL));

  console.log(`  user: ${email}`);
  console.log(`  id:   ${userId}`);

  console.log("bootstrap: verifying password sign-in…");
  const token = await signInWithPassword(supabaseUrl, anonKey, email, password);
  console.log(`  access_token: ${token.slice(0, 24)}… (${token.length} chars)`);

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    console.log("bootstrap: running db:migrate…");
    execSync("pnpm db:migrate", { cwd: repoRoot, stdio: "inherit" });
    console.log("bootstrap: running db:apply-functions…");
    execSync("pnpm --filter @meridian/database db:apply-functions", {
      cwd: repoRoot,
      stdio: "inherit",
    });

    const { default: postgres } = await import("postgres");
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const rows = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
      console.log(`bootstrap: DATABASE_URL ok (SELECT 1 → ${rows[0]?.ok})`);
      const authCheck = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM auth.users WHERE id = ${userId}::uuid
      `;
      console.log(`bootstrap: auth.users row present (count=${authCheck[0]?.count})`);

      const projectId = await seedDevProject(databaseUrl, userId);
      if (projectId) {
        console.log(`bootstrap: sample project ready (${projectId}) with fs + kb context sources`);
      }
    } finally {
      await sql.end();
    }
  } else {
    console.log(
      "bootstrap: DATABASE_URL not set — skip DB migrate/seed (add to .env after pnpm supabase:env)",
    );
  }

  console.log("\nDone. Set TEST_USER_ID in .env if you want a fixed override:");
  console.log(`  TEST_USER_ID=${userId}`);
  console.log("\nNext: pnpm dev");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
