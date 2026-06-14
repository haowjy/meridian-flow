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

/** Supabase CLI owns database creation; this verifies the configured DB is reachable. */
export async function ensureDatabaseForUrl(
  databaseUrl: string,
): Promise<{ targetDb: string; created: false }> {
  const { targetDb } = parseTargetDatabase(databaseUrl);
  validateDbName(targetDb);
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`SELECT 1`;
    return { targetDb, created: false };
  } finally {
    await sql.end();
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
    return `${message}\n  Hint: run pnpm supabase:start, then pnpm supabase:env and update .env.`;
  }
  if (err.code === "28P01")
    return `${message}\n  Hint: refresh local Supabase credentials with pnpm supabase:env.`;
  if (err.code === "3D000") return `${message}\n  Hint: run pnpm db:migrate after Supabase starts.`;
  return message;
}

export async function dropDatabaseForUrl(): Promise<never> {
  throw new Error("Meridian local DB reset is owned by Supabase CLI. Use pnpm supabase:reset.");
}
