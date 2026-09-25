/** Applies the committed migration journal and canonical function SQL. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";

interface MigrationJournal {
  entries: Array<{ tag: string; when: number }>;
}

class MigrationStatementError extends Error {
  constructor(
    readonly migrationPath: string,
    cause: unknown,
  ) {
    super(`Migration statement failed in ${migrationPath}`, { cause });
    this.name = "MigrationStatementError";
  }
}

const functionFiles = [
  "update_updated_at.sql",
  "validate_turn_thread_integrity.sql",
  "consume_credit_lots_fifo.sql",
];

export async function runRelease(input: {
  databaseUrl: string;
  migrationsDirectory: string;
  functionsDirectory: string;
  beforeMigrate?: (pendingMigrations: number) => void | Promise<void>;
}): Promise<{ appliedMigrations: number }> {
  const client = postgres(input.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const journal = JSON.parse(
      readFileSync(path.join(input.migrationsDirectory, "meta/_journal.json"), "utf8"),
    ) as MigrationJournal;
    const migrations = readMigrationFiles({ migrationsFolder: input.migrationsDirectory });
    if (journal.entries.length !== migrations.length) {
      throw new Error("Migration journal does not match the committed migration files");
    }
    for (const name of functionFiles) {
      if (!readdirSync(input.functionsDirectory).includes(name)) {
        throw new Error(`Missing canonical function SQL file: ${name}`);
      }
    }

    await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await client`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `;
    for (const [index, migration] of migrations.entries()) {
      const entry = journal.entries[index];
      if (!entry || entry.when !== migration.folderMillis) {
        throw new Error(`Migration journal entry ${index} does not match its SQL file`);
      }
    }
    const applied = await client<Array<{ hash: string; created_at: string | number | null }>>`
      SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC
    `;
    const compared = Math.min(applied.length, migrations.length);
    for (let index = 0; index < compared; index += 1) {
      const row = applied[index];
      const migration = migrations[index];
      if (row.hash !== migration.hash || Number(row.created_at) !== migration.folderMillis) {
        throw new Error(
          `Divergent migration history at ordinal ${index}: database ledger does not match the release journal`,
        );
      }
    }
    const pending =
      applied.length >= migrations.length
        ? []
        : migrations.slice(applied.length).map((migration, offset) => ({
            migration,
            entry: journal.entries[applied.length + offset],
          }));

    await input.beforeMigrate?.(pending.length);

    await client.begin(async (tx) => {
      for (const { migration, entry } of pending) {
        const migrationPath = path.join(input.migrationsDirectory, `${entry.tag}.sql`);
        for (const statement of migration.sql) {
          try {
            await tx.unsafe(statement);
          } catch (error) {
            throw new MigrationStatementError(migrationPath, error);
          }
        }
        await tx.unsafe(
          `INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ($1, $2)`,
          [migration.hash, migration.folderMillis],
        );
      }
      for (const name of functionFiles) {
        await tx.unsafe(readFileSync(path.join(input.functionsDirectory, name), "utf8"));
      }
    });
    return { appliedMigrations: pending.length };
  } finally {
    await client.end();
  }
}

export function formatMigrationFailure(error: unknown): string {
  const chain: Array<{
    cause?: unknown;
    code?: unknown;
    message?: unknown;
    migrationPath?: unknown;
  }> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const details = current as (typeof chain)[number];
    chain.push(details);
    current = details.cause;
  }
  const postgresError = [...chain].reverse().find((details) => typeof details.message === "string");
  const message =
    typeof postgresError?.message === "string" ? postgresError.message : String(error);
  const code = typeof postgresError?.code === "string" ? ` [${postgresError.code}]` : "";
  const migration = chain.find(
    (details) => typeof details.migrationPath === "string",
  )?.migrationPath;
  return `db:release: failed\n  migration: ${typeof migration === "string" ? migration : "unknown (failure occurred outside a migration statement)"}\n  postgres${code}: ${message}`;
}

export async function runMigrations(input: {
  databaseUrl: string;
  migrationsDirectory: string;
}): Promise<void> {
  await runRelease({
    ...input,
    functionsDirectory: path.resolve(input.migrationsDirectory, "../functions"),
  });
}

export async function applyFunctions(input: {
  databaseUrl: string;
  functionsDirectory: string;
}): Promise<void> {
  const client = postgres(input.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      for (const name of functionFiles) {
        await tx.unsafe(readFileSync(path.join(input.functionsDirectory, name), "utf8"));
      }
    });
  } finally {
    await client.end();
  }
}
