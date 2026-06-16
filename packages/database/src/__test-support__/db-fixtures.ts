/**
 * Shared auth.users fixture identity for DB-backed tests.
 * Never overlaps the dev-login user (TEST_USER_EMAIL / test@meridian.dev).
 */
import { sql } from "drizzle-orm";
import postgres from "postgres";

export const DB_TEST_FIXTURE_USER_ID_PRIMARY = "00000000-0000-4000-8000-000000000111";
export const DB_TEST_FIXTURE_USER_ID_EVENT_JOURNAL = "00000000-0000-4000-8000-000000000112";

/** Reserved RFC 2606 domain; suite suffix keeps emails unique per test file. */
export function dbTestFixtureEmail(suite: string): string {
  const normalized = suite
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `fixture+${normalized}@test.invalid`;
}

export function databaseNameFromUrl(databaseUrl: string): string {
  const withoutQuery = databaseUrl.split("?")[0] ?? databaseUrl;
  const slash = withoutQuery.lastIndexOf("/");
  if (slash === -1 || slash === withoutQuery.length - 1) {
    throw new Error(`Cannot parse database name from DATABASE_URL: ${databaseUrl}`);
  }
  return decodeURIComponent(withoutQuery.slice(slash + 1));
}

/** Refuse RUN_DB_TESTS when DATABASE_URL targets the dev database. */
export function assertThrowawayDatabaseForRunDbTests(databaseUrl: string): void {
  const dbName = databaseNameFromUrl(databaseUrl);
  if (dbName === "postgres") {
    throw new Error(
      'RUN_DB_TESTS refused: DATABASE_URL points at the dev database "postgres". ' +
        'Create a throwaway database whose name contains "test" (e.g. meridian_test) and set DATABASE_URL to it.',
    );
  }
  if (!dbName.toLowerCase().includes("test")) {
    throw new Error(
      `RUN_DB_TESTS refused: DATABASE_URL database "${dbName}" must contain "test" ` +
        "to prevent accidental pollution of the dev database.",
    );
  }
}

export function assertLocalSupabaseOrExplicitAllow(databaseUrl: string | undefined): void {
  if (!databaseUrl || process.env.TEST_DB_ALLOW_DESTRUCTIVE === "1") return;
  if (!databaseUrl.includes("127.0.0.1:54422")) {
    throw new Error(
      "Refusing DB tests: DATABASE_URL must be local Supabase (127.0.0.1:54422) or set TEST_DB_ALLOW_DESTRUCTIVE=1",
    );
  }
}

/** Seed or refresh a dedicated fixture user; never reads TEST_USER_EMAIL. */
export async function resolveDbTestFixtureUserId(
  databaseUrl: string,
  options: { fixtureUserId: string; suite: string },
): Promise<string> {
  const email = dbTestFixtureEmail(options.suite);
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await client<{ id: string }[]>`
      INSERT INTO auth.users (
        id, email, aud, role, raw_app_meta_data, raw_user_meta_data,
        email_confirmed_at, created_at, updated_at
      )
      VALUES (
        ${options.fixtureUserId}::uuid, ${email}, 'authenticated', 'authenticated',
        '{}'::jsonb, '{}'::jsonb, now(), now(), now()
      )
      ON CONFLICT (id) DO UPDATE
      SET email = excluded.email, updated_at = now()
      RETURNING id::text
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error(`Failed to seed auth.users fixture for suite ${options.suite}`);
    return id;
  } finally {
    await client.end();
  }
}

type ExecutableDb = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export async function seedAuthUser(db: ExecutableDb, id: string, email: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO auth.users (
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    )
    VALUES (
      ${id}::uuid,
      'authenticated',
      'authenticated',
      ${email},
      '',
      now(),
      '{}'::jsonb,
      '{}'::jsonb,
      now(),
      now()
    )
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()
  `);
}
