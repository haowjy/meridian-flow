/** Programmatic Drizzle migration runner with file-aware PostgreSQL failures. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { isLocalDevPostgres } from "./dev-db";
import {
  formatDatabaseHistoryRefusal,
  planDatabaseMigrations,
  readAppliedMigrations,
  readMigrationHistory,
} from "./migration-history";

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
    const migrations = readMigrationFiles({ migrationsFolder: input.migrationsDirectory });
    if (history.entries.length !== migrations.length) {
      throw new MigrationHistoryError(
        "db:migrate: refused inconsistent migration files\n  - migration journal does not match the committed migration files",
      );
    }
    const migrationsByTag = new Map<string, (typeof migrations)[number]>();
    for (const [index, migration] of migrations.entries()) {
      const entry = history.entries[index];
      if (!entry || entry.when !== migration.folderMillis || entry.hash !== migration.hash) {
        throw new MigrationHistoryError(
          `db:migrate: refused inconsistent migration files\n  - migration journal entry ${index} does not match its SQL file`,
        );
      }
      migrationsByTag.set(entry.tag, migration);
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
        const migration = migrationsByTag.get(entry.tag);
        if (!migration) {
          throw new MigrationHistoryError(
            `db:migrate: refused inconsistent migration files\n  - migration ${entry.tag} is missing from Drizzle's journal`,
          );
        }
        const migrationPath = path.join(input.migrationsDirectory, `${entry.tag}.sql`);
        const noTransaction =
          readFileSync(migrationPath, "utf8").split("\n")[0] === "-- migration: no-transaction";
        // Reserved postgres.js sessions do not expose begin(); keep transaction
        // control on the same connection that owns the session advisory lock.
        if (!noTransaction) await session`BEGIN`;
        try {
          for (const statement of migration.sql) {
            await session.unsafe(statement);
          }
          await session.unsafe(
            `INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)`,
            [migration.hash, migration.folderMillis],
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
