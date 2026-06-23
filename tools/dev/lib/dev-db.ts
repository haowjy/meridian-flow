import postgres from "postgres";

/** Host port mapped in tools/dev/docker-compose.yml (postgres:16 → 54422). */
export const LOCAL_DEV_POSTGRES_PORT = 54422;

const RESERVED_DATABASES = new Set(["postgres", "template0", "template1", "meridian"]);

export interface ParsedTargetDatabase {
  targetDb: string;
  adminConnString: string;
}

interface PgLikeError {
  code?: unknown;
  message?: unknown;
  errno?: unknown;
  address?: unknown;
  port?: unknown;
  hostname?: unknown;
  host?: unknown;
  database?: unknown;
}

export function parseTargetDatabase(databaseUrl: string): ParsedTargetDatabase {
  const url = new URL(databaseUrl);
  const targetDb = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!targetDb) throw new Error("DATABASE_URL has no database name");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  return { targetDb, adminConnString: adminUrl.toString() };
}

export function validateDbName(name: string): void {
  if (!/^[a-z_][a-z0-9_-]*$/.test(name)) {
    throw new Error(`Refusing to use unsafe database name: ${name || "<empty>"}`);
  }
  if (Buffer.byteLength(name, "utf8") > 63) {
    throw new Error(`Refusing to use database name longer than 63 bytes: ${name}`);
  }
}

export function isReservedDatabase(name: string, mainDbNames: Iterable<string>): boolean {
  if (RESERVED_DATABASES.has(name)) return true;
  for (const mainDbName of mainDbNames) if (name === mainDbName) return true;
  return false;
}

function validateExtensionName(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to create extension with unsafe name: ${name || "<empty>"}`);
  }
}

function parsePostgresPort(databaseUrl: string): number {
  const port = new URL(databaseUrl).port;
  return port ? Number.parseInt(port, 10) : 5432;
}

/** True when DATABASE_URL targets the committed local dev Postgres endpoint. */
export function isLocalDevPostgres(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    const hostname = url.hostname;
    const isLocalHost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    if (!isLocalHost) return false;
    return parsePostgresPort(databaseUrl) === LOCAL_DEV_POSTGRES_PORT;
  } catch {
    return false;
  }
}

function assertLocalDevPostgresEndpoint(databaseUrl: string, action: string): void {
  if (isLocalDevPostgres(databaseUrl)) return;
  const url = new URL(databaseUrl);
  const port = parsePostgresPort(databaseUrl);
  throw new Error(
    `Refusing to ${action} on non-local dev Postgres endpoint ` +
      `(expected 127.0.0.1:${LOCAL_DEV_POSTGRES_PORT}, localhost:${LOCAL_DEV_POSTGRES_PORT}, or ::1:${LOCAL_DEV_POSTGRES_PORT}): ` +
      `got ${url.hostname}:${port}`,
  );
}

/**
 * Read-only reachability probe: connect and `SELECT 1` without creating or
 * mutating anything. Surfaces the same Postgres error codes (`ECONNREFUSED`,
 * `3D000`, `28P01`) that `formatPgError` turns into actionable hints, so the
 * dev preflight can fail fast before launching the app servers.
 */
export async function pingDatabaseForUrl(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
  try {
    await sql`SELECT 1`;
  } finally {
    await sql.end();
  }
}

/**
 * Read applied drizzle migration hashes (oldest first). Returns `null` when the
 * `drizzle.__drizzle_migrations` table does not exist, i.e. the database was
 * never migrated — callers distinguish that from an up-to-date empty result.
 */
export async function readAppliedMigrationHashes(databaseUrl: string): Promise<string[] | null> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
  try {
    const present = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`;
    if (!present[0]?.exists) return null;
    const rows = await sql<{ hash: string }[]>`
      SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
    return rows.map((row) => row.hash);
  } finally {
    await sql.end();
  }
}

/** List local worktree-shaped databases for the registered dev DB base names. */
export async function listWorktreeDatabasesForUrl(
  databaseUrl: string,
  baseDbNames: readonly string[],
): Promise<string[]> {
  assertLocalDevPostgresEndpoint(databaseUrl, "list databases");
  if (baseDbNames.length === 0) return [];

  const prefixes = baseDbNames.map((baseDbName) => `${baseDbName}_`);
  const { adminConnString } = parseTargetDatabase(databaseUrl);
  const adminSql = postgres(adminConnString, { max: 1 });
  try {
    const rows = await adminSql<{ datname: string }[]>`
      SELECT datname
      FROM pg_database
      WHERE datistemplate = false
      ORDER BY datname`;
    return rows
      .map((row) => row.datname)
      .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
  } finally {
    await adminSql.end();
  }
}

/** Connect to target DB when present; auto-create only on the local dev endpoint. */
export async function ensureDatabaseForUrl(
  databaseUrl: string,
): Promise<{ targetDb: string; created: boolean }> {
  const { targetDb, adminConnString } = parseTargetDatabase(databaseUrl);
  validateDbName(targetDb);

  const targetSql = postgres(databaseUrl, { max: 1 });
  try {
    await targetSql`SELECT 1`;
    return { targetDb, created: false };
  } catch (error) {
    const err = error as PgLikeError;
    if (err.code !== "3D000") throw error;
  } finally {
    await targetSql.end();
  }

  if (!isLocalDevPostgres(databaseUrl)) {
    throw new Error(
      `Database "${targetDb}" does not exist. Create it on your Postgres host or point DATABASE_URL at an existing database. ` +
        `Auto-create is only available for the local dev Postgres endpoint (127.0.0.1:${LOCAL_DEV_POSTGRES_PORT}).`,
    );
  }

  const adminSql = postgres(adminConnString, { max: 1 });
  try {
    try {
      await adminSql.unsafe(`CREATE DATABASE "${targetDb}"`);
      return { targetDb, created: true };
    } catch (error) {
      const err = error as PgLikeError;
      if (err.code === "42P04") return { targetDb, created: false };
      throw error;
    }
  } finally {
    await adminSql.end();
  }
}

export async function ensureExtensionsForUrl(
  databaseUrl: string,
  extensions: readonly string[],
): Promise<void> {
  if (extensions.length === 0) return;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const extension of extensions) {
      validateExtensionName(extension);
      await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
    }
  } finally {
    await sql.end();
  }
}

export async function executeSqlForUrl(databaseUrl: string, body: string): Promise<void> {
  if (!body.trim()) return;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(body);
  } finally {
    await sql.end();
  }
}

export function formatPgError(error: unknown): string {
  const err = error as PgLikeError;
  const message = typeof err.message === "string" ? err.message : String(error);
  if (err.code === "ECONNREFUSED") {
    return `${message}\n  Hint: run pnpm dev:infra to start the local Postgres container, then check DATABASE_URL in .env.`;
  }
  if (err.code === "28P01") {
    return `${message}\n  Hint: check DATABASE_URL credentials in .env (default: postgres/postgres).`;
  }
  if (err.code === "3D000") {
    return `${message}\n  Hint: run pnpm bootstrap after the Postgres container is up.`;
  }
  return message;
}

/** Drop and recreate app schemas so migrations re-apply from scratch (keeps the database). */
export async function resetSchemaForUrl(databaseUrl: string): Promise<{ targetDb: string }> {
  assertLocalDevPostgresEndpoint(databaseUrl, "reset schema");
  const { targetDb } = parseTargetDatabase(databaseUrl);
  validateDbName(targetDb);
  await executeSqlForUrl(
    databaseUrl,
    `
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
    `,
  );
  return { targetDb };
}

export async function dropDatabaseForUrl(
  databaseUrl: string,
  mainDbNames: Iterable<string>,
): Promise<{ targetDb: string; dropped: boolean }> {
  assertLocalDevPostgresEndpoint(databaseUrl, "drop database");
  const { targetDb, adminConnString } = parseTargetDatabase(databaseUrl);
  validateDbName(targetDb);
  if (isReservedDatabase(targetDb, mainDbNames)) {
    throw new Error(`Refusing to drop reserved database: ${targetDb}`);
  }

  const adminSql = postgres(adminConnString, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE)`);
    return { targetDb, dropped: true };
  } finally {
    await adminSql.end();
  }
}
