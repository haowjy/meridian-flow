/** Programmatic Drizzle migration runner with file-aware PostgreSQL failures. */
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import {
  type AppliedMigration,
  formatDatabaseHistoryRefusal,
  planDatabaseMigrations,
  readMigrationHistory,
} from "./migration-history";

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
  const client = postgres(input.databaseUrl, { max: 1 });
  try {
    const history = readMigrationHistory(input.migrationsDirectory);
    if (history.issues.length > 0) {
      throw new MigrationHistoryError(
        `db:migrate: refused inconsistent migration files\n${history.issues.map((issue) => `  - ${issue}`).join("\n")}`,
      );
    }
    const migrations = readMigrationFiles({ migrationsFolder: input.migrationsDirectory });
    if (history.entries.length !== migrations.length) {
      throw new Error("Migration journal does not match the committed migration files");
    }
    const migrationsByTag = new Map<string, (typeof migrations)[number]>();
    for (const [index, migration] of migrations.entries()) {
      const entry = history.entries[index];
      if (!entry || entry.when !== migration.folderMillis || entry.hash !== migration.hash) {
        throw new Error(`Migration journal entry ${index} does not match its SQL file`);
      }
      migrationsByTag.set(entry.tag, migration);
    }

    const [{ migrationsTableExists }] = await client<
      Array<{ migrationsTableExists: boolean }>
    >`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS "migrationsTableExists"`;
    const applied: AppliedMigration[] = migrationsTableExists
      ? await client<Array<{ hash: string; createdAt: string | number }>>`
          SELECT hash, created_at AS "createdAt"
          FROM drizzle.__drizzle_migrations
          ORDER BY created_at, id
        `.then((rows) => rows.map((row) => ({ hash: row.hash, createdAt: Number(row.createdAt) })))
      : [];
    const plan = planDatabaseMigrations(history, applied);
    if (plan.issues.length > 0) {
      const databaseName = decodeURIComponent(
        new URL(input.databaseUrl).pathname.replace(/^\//, ""),
      );
      throw new MigrationHistoryError(
        formatDatabaseHistoryRefusal({ databaseName, issues: plan.issues }),
      );
    }

    await client.begin(async (transaction) => {
      await transaction`CREATE SCHEMA IF NOT EXISTS drizzle`;
      await transaction`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `;
      for (const entry of plan.pending) {
        const migration = migrationsByTag.get(entry.tag);
        if (!migration) throw new Error(`Migration ${entry.tag} has no SQL statements`);
        const migrationPath = path.join(input.migrationsDirectory, `${entry.tag}.sql`);
        for (const statement of migration.sql) {
          try {
            await transaction.unsafe(statement);
          } catch (error) {
            throw new MigrationStatementError(migrationPath, error);
          }
        }
        await transaction.unsafe(
          `INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)`,
          [migration.hash, migration.folderMillis],
        );
      }
    });
  } finally {
    await client.end();
  }
}
