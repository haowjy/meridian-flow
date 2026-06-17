/**
 * Shared public.users fixture identity for DB-backed tests.
 * Never overlaps the dev-login user (WORKOS_DEV_LOGIN_EMAIL / test@meridian.dev).
 */
import { sql } from "drizzle-orm";
import postgres from "postgres";

export const DB_TEST_FIXTURE_USER_ID_PRIMARY = "00000000-0000-4000-8000-000000000111";
export const DB_TEST_FIXTURE_USER_ID_EVENT_JOURNAL = "00000000-0000-4000-8000-000000000112";

const DEV_DATABASE_NAMES = new Set(["postgres", "meridian"]);

/** Reserved RFC 2606 domain; suite suffix keeps emails unique per test file. */
export function dbTestFixtureEmail(suite: string): string {
  const normalized = suite
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `fixture+${normalized}@test.invalid`;
}

/** Deterministic WorkOS external id per test suite (never overlaps production credentials). */
export function dbTestFixtureExternalId(suite: string): string {
  return `fixture-external-${suite.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`;
}

export function databaseNameFromUrl(databaseUrl: string): string {
  const withoutQuery = databaseUrl.split("?")[0] ?? databaseUrl;
  const slash = withoutQuery.lastIndexOf("/");
  if (slash === -1 || slash === withoutQuery.length - 1) {
    throw new Error(`Cannot parse database name from DATABASE_URL: ${databaseUrl}`);
  }
  return decodeURIComponent(withoutQuery.slice(slash + 1));
}

export function isLocalDatabaseHost(databaseUrl: string): boolean {
  try {
    const hostname = new URL(databaseUrl).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Refuse RUN_DB_TESTS when DATABASE_URL targets the dev database. */
export function assertThrowawayDatabaseForRunDbTests(databaseUrl: string): void {
  const dbName = databaseNameFromUrl(databaseUrl);
  if (DEV_DATABASE_NAMES.has(dbName)) {
    throw new Error(
      `RUN_DB_TESTS refused: DATABASE_URL points at the dev database "${dbName}". ` +
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

export function assertLocalDevPostgresOrExplicitAllow(databaseUrl: string | undefined): void {
  if (!databaseUrl || process.env.TEST_DB_ALLOW_DESTRUCTIVE === "1") return;
  if (!isLocalDatabaseHost(databaseUrl)) {
    throw new Error(
      "Refusing DB tests: DATABASE_URL must target local dev Postgres (127.0.0.1/localhost) or set TEST_DB_ALLOW_DESTRUCTIVE=1",
    );
  }
}

/** Seed or refresh a dedicated fixture user; never reads WORKOS_DEV_LOGIN_EMAIL. */
export async function resolveDbTestFixtureUserId(
  databaseUrl: string,
  options: { fixtureUserId: string; suite: string },
): Promise<string> {
  const email = dbTestFixtureEmail(options.suite);
  const externalId = dbTestFixtureExternalId(options.suite);
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await client<{ id: string }[]>`
      INSERT INTO public.users (
        id, external_id, email, created_at, updated_at
      )
      VALUES (
        ${options.fixtureUserId}::uuid, ${externalId}, ${email}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE
      SET email = excluded.email, external_id = excluded.external_id, updated_at = now()
      RETURNING id::text
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error(`Failed to seed public.users fixture for suite ${options.suite}`);
    return id;
  } finally {
    await client.end();
  }
}

type ExecutableDb = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export async function seedUser(db: ExecutableDb, id: string, email: string): Promise<void> {
  const externalId = `fixture-external-${id}`;
  await db.execute(sql`
    INSERT INTO public.users (
      id,
      external_id,
      email,
      created_at,
      updated_at
    )
    VALUES (
      ${id}::uuid,
      ${externalId},
      ${email},
      now(),
      now()
    )
    ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email, external_id = EXCLUDED.external_id, updated_at = now()
  `);
}

/** Drizzle insert shape for conformance tests that need a fixed user id. */
export function conformanceUserValues(id: string, suite: string) {
  return {
    id,
    externalId: `fixture-external-${id}`,
    email: dbTestFixtureEmail(suite),
  };
}
