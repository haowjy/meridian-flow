import { sql } from "drizzle-orm";
import postgres from "postgres";

export const DB_TEST_FIXTURE_USER_ID_PRIMARY = "00000000-0000-4000-8000-000000000111";

const DEV_DATABASE_NAMES = new Set(["postgres", "meridian"]);

const LOCAL_DEV_POSTGRES_PORT = 54422;

export function dbTestFixtureEmail(suite: string): string {
  const normalized = suite
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `fixture+${normalized}@test.invalid`;
}

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

function isLocalDevPostgres(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    const hostname = url.hostname;
    const isLocalHost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    if (!isLocalHost) return false;
    const port = url.port ? Number.parseInt(url.port, 10) : 5432;
    return port === LOCAL_DEV_POSTGRES_PORT;
  } catch {
    return false;
  }
}

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
  if (!isLocalDevPostgres(databaseUrl)) {
    throw new Error(
      `Refusing DB tests: DATABASE_URL must target local dev Postgres (127.0.0.1:${LOCAL_DEV_POSTGRES_PORT} or localhost:${LOCAL_DEV_POSTGRES_PORT}) or set TEST_DB_ALLOW_DESTRUCTIVE=1`,
    );
  }
}

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

export function conformanceUserValues(id: string, suite: string) {
  return {
    id,
    externalId: `fixture-external-${id}`,
    email: dbTestFixtureEmail(suite),
  };
}
