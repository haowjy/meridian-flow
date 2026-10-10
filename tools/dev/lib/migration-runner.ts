/** Programmatic Drizzle migration runner with file-aware PostgreSQL failures. */
import path from "node:path";
import postgres from "postgres";
import { isLocalDevPostgres } from "./dev-db";
import {
  formatDatabaseHistoryRefusal,
  planDatabaseMigrations,
  readAppliedMigrations,
  readMigrationHistory,
} from "./migration-history";

import {
  CONCURRENT_INDEX_CREATE,
  executableSql,
  isNoTransactionMigration,
  normalizeMigrationSql,
} from "./migration-sql";

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
    const history = readMigrationHistory(input.migrationsDirectory);
    if (history.issues.length > 0) {
      throw new MigrationHistoryError(
        `db:migrate: refused inconsistent migration files\n${history.issues.map((issue) => `  - ${issue}`).join("\n")}`,
      );
    }
    const session = await client.reserve();
    try {
      await session`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
      const applied = (await readAppliedMigrations(session)) ?? [];
      const plan = planDatabaseMigrations(history, applied);
      if (plan.issues.length > 0) {
        const databaseName = decodeURIComponent(
          new URL(input.databaseUrl).pathname.replace(/^\//, ""),
        );
        throw new MigrationHistoryError(
          formatDatabaseHistoryRefusal({
            databaseName,
            issues: plan.issues,
            localDevDatabase: isLocalDevPostgres(input.databaseUrl),
          }),
        );
      }
      await session`CREATE SCHEMA IF NOT EXISTS drizzle`;
      await session`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `;
      for (const entry of plan.pending) {
        const migrationPath = path.join(input.migrationsDirectory, `${entry.tag}.sql`);
        const content = normalizeMigrationSql(
          (history.sqlFiles.get(`${entry.tag}.sql`) as Buffer).toString("utf8"),
        );
        const noTransaction = isNoTransactionMigration(content);
        // Reserved postgres.js sessions do not expose begin(); keep transaction
        // control on the same connection that owns the session advisory lock.
        if (!noTransaction) await session`BEGIN`;
        try {
          if (noTransaction) {
            for (const match of executableSql(content).matchAll(CONCURRENT_INDEX_CREATE)) {
              const [index] = await session`SELECT i.indisvalid,
                quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS name
                FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.oid = to_regclass(${match[1]})`;
              if (index && !index.indisvalid) {
                await session.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
              }
            }
          }
          for (const statement of content.split("--> statement-breakpoint")) {
            await session.unsafe(statement);
          }
          await session.unsafe(
            `INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)`,
            [entry.hash, entry.when],
          );
          if (!noTransaction) await session`COMMIT`;
        } catch (error) {
          observeFailure(error);
          if (!noTransaction && !disconnected) await cleanup(() => session`ROLLBACK`);
          throw new MigrationStatementError(migrationPath, error);
        }
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
