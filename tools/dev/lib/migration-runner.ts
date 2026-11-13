/** Programmatic Drizzle migration runner with file-aware PostgreSQL failures. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { isLocalDevPostgres } from "./dev-db";

interface Baseline {
  hash: string;
  sql: string;
}

function readBaseline(directory: string): Baseline {
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql"));
  if (files.length !== 1 || files[0] !== "0000_baseline.sql") {
    throw new Error("Expected one 0000_baseline.sql; run pnpm db:generate");
  }
  const bytes = readFileSync(path.join(directory, "0000_baseline.sql"));
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    sql: bytes
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n"),
  };
}

async function baselineStatus(
  session: postgres.Sql | postgres.ReservedSql,
  baseline: Baseline,
  databaseUrl: string,
): Promise<"pending" | "current"> {
  const [present] =
    await session`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`;
  if (!present.exists) return "pending";
  const rows = await session<{ hash: string }[]>`SELECT hash FROM drizzle.__drizzle_migrations`;
  if (rows.length === 0) return "pending";
  if (rows.length === 1 && rows[0].hash === baseline.hash) return "current";
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  throw new MigrationHistoryError(
    `db:migrate: database "${databaseName}" has a different baseline.\n` +
      (isLocalDevPostgres(databaseUrl)
        ? "Run `pnpm db:reset` from the checkout that owns this dev database."
        : "This is a shared or deployed database and requires human repair. Do not reset it."),
  );
}

export async function currentBaselineStatus(input: {
  databaseUrl: string;
  migrationsDirectory: string;
}): Promise<"pending" | "current"> {
  const baseline = readBaseline(input.migrationsDirectory);
  const client = postgres(input.databaseUrl, { max: 1, connect_timeout: 5 });
  try {
    return await baselineStatus(client, baseline, input.databaseUrl);
  } finally {
    await client.end();
  }
}

export const MIGRATION_ADVISORY_LOCK_ID = 4_884_217_039_117;

interface ErrorDetails {
  cause?: unknown;
  code?: unknown;
  message?: unknown;
  migrationPath?: unknown;
}

class MigrationStatementError extends Error {
  readonly migrationPath: string;

  constructor(migrationPath: string, cause: unknown) {
    super(`Migration statement failed in ${migrationPath}`, { cause });
    this.name = "MigrationStatementError";
    this.migrationPath = migrationPath;
  }
}

class MigrationHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationHistoryError";
  }
}

function errorChain(error: unknown): ErrorDetails[] {
  const chain: ErrorDetails[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const details = current as ErrorDetails;
    chain.push(details);
    current = details.cause;
  }
  return chain;
}

export function formatMigrationFailure(error: unknown, input: { repoRoot: string }): string {
  if (error instanceof MigrationHistoryError) return error.message;
  const chain = errorChain(error);
  const postgresError = [...chain].reverse().find((details) => typeof details.message === "string");
  const message =
    typeof postgresError?.message === "string" ? postgresError.message : String(error);
  const code = typeof postgresError?.code === "string" ? ` [${postgresError.code}]` : "";
  const migrationPath = chain.find(
    (details): details is ErrorDetails & { migrationPath: string } =>
      typeof details.migrationPath === "string",
  )?.migrationPath;
  const migration = migrationPath
    ? path.relative(input.repoRoot, migrationPath)
    : "unknown (failure occurred outside a migration statement)";
  return `db:migrate: failed\n  migration: ${migration}\n  postgres${code}: ${message}`;
}

export async function runMigrations(input: {
  databaseUrl: string;
  migrationsDirectory: string;
}): Promise<void> {
  let disconnected = false;
  let failed = false;
  const client = postgres(input.databaseUrl, {
    max: 1,
    onclose: () => {
      disconnected = true;
    },
  });
  // FATAL errors can arrive before postgres.js emits onclose.
  function observeFailure(error: unknown) {
    const details = error as { severity?: string; code?: string };
    if (
      details?.severity === "FATAL" ||
      details?.code?.startsWith("CONNECTION_") ||
      details?.code?.startsWith("08")
    )
      disconnected = true;
    failed = true;
  }
  async function cleanup(action: () => unknown | Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      observeFailure(error);
      // Cleanup is best effort; it must never replace the file-aware failure.
    }
  }
  try {
    const baseline = readBaseline(input.migrationsDirectory);
    const session = await client.reserve();
    try {
      await session`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
      if ((await baselineStatus(session, baseline, input.databaseUrl)) === "current") return;
      const migrationPath = path.join(input.migrationsDirectory, "0000_baseline.sql");
      // Reserved sessions need transaction control on the connection holding the lock.
      await session`BEGIN`;
      try {
        await session`CREATE SCHEMA IF NOT EXISTS drizzle`;
        await session`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
        )`;
        for (const statement of baseline.sql.split("--> statement-breakpoint")) {
          await session.unsafe(statement);
        }
        await session`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${baseline.hash}, 0)`;
        await session`COMMIT`;
      } catch (error) {
        observeFailure(error);
        if (!disconnected) await cleanup(() => session`ROLLBACK`);
        throw new MigrationStatementError(migrationPath, error);
      }
    } catch (error) {
      observeFailure(error);
      throw error;
    } finally {
      // Backend termination releases its advisory lock. A dead reserved session
      // cannot reconnect safely, so never submit cleanup SQL to it.
      if (!disconnected) {
        await cleanup(() => session`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`);
        if (!disconnected) await cleanup(() => session.release());
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) await cleanup(() => client.end({ timeout: 1 }));
    else await client.end();
  }
}
