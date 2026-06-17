import postgres from "postgres";

const RESERVED_DATABASES = new Set(["postgres", "template0", "template1"]);

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

export function isLocalDatabaseHost(databaseUrl: string): boolean {
  try {
    const hostname = new URL(databaseUrl).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Connect to admin DB and CREATE DATABASE when the target is missing. */
export async function ensureDatabaseForUrl(
  databaseUrl: string,
): Promise<{ targetDb: string; created: boolean }> {
  const { targetDb, adminConnString } = parseTargetDatabase(databaseUrl);
  validateDbName(targetDb);

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
  if (!isLocalDatabaseHost(databaseUrl)) {
    throw new Error(`Refusing to reset schema on non-local host: ${new URL(databaseUrl).hostname}`);
  }
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
  if (!isLocalDatabaseHost(databaseUrl)) {
    throw new Error(
      `Refusing to drop database on non-local host: ${new URL(databaseUrl).hostname}`,
    );
  }
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
