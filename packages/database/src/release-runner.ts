/** Applies the committed migration journal and canonical function SQL. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";

interface MigrationJournal {
  entries: Array<{ tag: string; when: number }>;
}

export type SchemaStatus = "current" | "ahead" | "behind" | "divergent";

function readReleaseMigrations(migrationsDirectory: string) {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsDirectory, "meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
  const migrations = readMigrationFiles({ migrationsFolder: migrationsDirectory });
  if (journal.entries.length !== migrations.length) {
    throw new Error("Migration journal does not match the committed migration files");
  }
  for (const [index, migration] of migrations.entries()) {
    const entry = journal.entries[index];
    if (!entry || entry.when !== migration.folderMillis) {
      throw new Error(`Migration journal entry ${index} does not match its SQL file`);
    }
  }
  return { journal, migrations };
}

function compareMigrationHistory(
  applied: Array<{ hash: string; created_at: string | number | null }>,
  migrations: ReturnType<typeof readMigrationFiles>,
): SchemaStatus {
  const compared = Math.min(applied.length, migrations.length);
  for (let index = 0; index < compared; index += 1) {
    const row = applied[index];
    const migration = migrations[index];
    if (row.hash !== migration.hash || Number(row.created_at) !== migration.folderMillis) {
      return "divergent";
    }
  }
  if (applied.length < migrations.length) return "behind";
  return applied.length > migrations.length ? "ahead" : "current";
}

/** Compare the database ledger with the exact release bundle journal. */
export async function getSchemaStatus(input: {
  databaseUrl: string;
  migrationsDirectory: string;
}): Promise<SchemaStatus> {
  const { migrations } = readReleaseMigrations(input.migrationsDirectory);
  const client = postgres(input.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const [table] = await client<Array<{ exists: boolean }>>`
      SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists
    `;
    if (!table?.exists) return migrations.length === 0 ? "current" : "behind";
    const applied = await client<Array<{ hash: string; created_at: string | number | null }>>`
      SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC
    `;
    return compareMigrationHistory(applied, migrations);
  } finally {
    await client.end();
  }
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
const releaseAdvisoryLockKey = 87211140324721;

export async function runRelease(input: {
  databaseUrl: string;
  migrationsDirectory: string;
  functionsDirectory: string;
  beforeMigrate?: (pendingMigrations: number) => void | Promise<void>;
}): Promise<{ appliedMigrations: number; skippedFunctions: boolean }> {
  const client = postgres(input.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const { journal, migrations } = readReleaseMigrations(input.migrationsDirectory);
    for (const name of functionFiles) {
      if (!readdirSync(input.functionsDirectory).includes(name)) {
        throw new Error(`Missing canonical function SQL file: ${name}`);
      }
    }

    for (const [index, migration] of migrations.entries()) {
      const entry = journal.entries[index];
      if (!entry || entry.when !== migration.folderMillis) {
        throw new Error(`Migration journal entry ${index} does not match its SQL file`);
      }
    }
    let appliedMigrations = 0;
    let skippedFunctions = false;
    await client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");
      await tx.unsafe("SET LOCAL statement_timeout = '10min'");
      await tx.unsafe(`SELECT pg_advisory_xact_lock(${releaseAdvisoryLockKey})`);
      await tx`CREATE SCHEMA IF NOT EXISTS drizzle`;
      await tx`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `;
      const applied = await tx<Array<{ hash: string; created_at: string | number | null }>>`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC
      `;
      const schemaStatus = compareMigrationHistory(applied, migrations);
      if (schemaStatus === "divergent") {
        throw new Error(
          "Divergent migration history at ordinal 0 or later: database ledger does not match the release journal",
        );
      }
      const pending =
        applied.length >= migrations.length
          ? []
          : migrations.slice(applied.length).map((migration, offset) => ({
              migration,
              entry: journal.entries[applied.length + offset],
            }));
      await input.beforeMigrate?.(pending.length);

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
      if (schemaStatus !== "ahead") {
        for (const name of functionFiles) {
          await tx.unsafe(readFileSync(path.join(input.functionsDirectory, name), "utf8"));
        }
      }
      appliedMigrations = pending.length;
      skippedFunctions = schemaStatus === "ahead";
    });
    return { appliedMigrations, skippedFunctions };
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
