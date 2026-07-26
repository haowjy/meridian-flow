/** Programmatic Drizzle migration runner with file-aware PostgreSQL failures. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";

interface MigrationJournal {
  entries: Array<{ tag: string; when: number }>;
}

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
    const journal = JSON.parse(
      readFileSync(path.join(input.migrationsDirectory, "meta/_journal.json"), "utf8"),
    ) as MigrationJournal;
    const migrations = readMigrationFiles({ migrationsFolder: input.migrationsDirectory });
    if (journal.entries.length !== migrations.length) {
      throw new Error("Migration journal does not match the committed migration files");
    }

    await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await client`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `;
    const [lastDbMigration] = await client<
      Array<{ created_at: string | number | null }>
    >`SELECT created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC
      LIMIT 1`;

    await client.begin(async (transaction) => {
      for (const [index, migration] of migrations.entries()) {
        if (
          lastDbMigration?.created_at !== undefined &&
          lastDbMigration.created_at !== null &&
          Number(lastDbMigration.created_at) >= migration.folderMillis
        ) {
          continue;
        }

        const entry = journal.entries[index];
        if (!entry || entry.when !== migration.folderMillis) {
          throw new Error(`Migration journal entry ${index} does not match its SQL file`);
        }
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
