/** Applies the committed migration journal and canonical function SQL. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres, { type Sql } from "postgres";

import {
  type DatabaseHistoryIssue,
  formatDatabaseHistoryIssue,
  planDatabaseMigrations,
  readAppliedMigrations,
  readMigrationHistory,
} from "./migration-history.js";

export * from "./migration-history.js";

export type SchemaStatus = "current" | "ahead" | "behind" | "divergent";
export class DatabaseHistoryRefusalError extends Error {
  constructor(readonly issues: DatabaseHistoryIssue[]) {
    super("Database migration history is ahead of or divergent from this checkout");
    this.name = "DatabaseHistoryRefusalError";
  }
}

function readReleaseMigrations(migrationsDirectory: string) {
  const history = readMigrationHistory(migrationsDirectory);
  if (history.issues.length > 0) {
    throw new Error(
      `Refused inconsistent migration files\n${history.issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
  }
  const migrations = readMigrationFiles({ migrationsFolder: migrationsDirectory });
  if (history.entries.length !== migrations.length) {
    throw new Error("Migration journal does not match the committed migration files");
  }
  for (const [index, migration] of migrations.entries()) {
    const entry = history.entries[index];
    if (!entry || entry.when !== migration.folderMillis || entry.hash !== migration.hash) {
      throw new Error(`Migration journal entry ${index} does not match its SQL file`);
    }
  }
  return { history, migrations };
}

/** Compare the database ledger with the exact release bundle journal. */
export async function getSchemaStatus(input: {
  sql: Sql;
  migrationsDirectory: string;
}): Promise<SchemaStatus> {
  const { history } = readReleaseMigrations(input.migrationsDirectory);
  const plan = planDatabaseMigrations(history, (await readAppliedMigrations(input.sql)) ?? []);
  return plan.verdict === "pending" ? "behind" : plan.verdict;
}

export class MigrationStatementError extends Error {
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
  allowAhead?: boolean;
}): Promise<{ appliedMigrations: number; skippedFunctions: boolean }> {
  const client = postgres(input.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const { history, migrations } = readReleaseMigrations(input.migrationsDirectory);
    for (const name of functionFiles) {
      if (!readdirSync(input.functionsDirectory).includes(name)) {
        throw new Error(`Missing canonical function SQL file: ${name}`);
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
      const applied = (await readAppliedMigrations(tx)) ?? [];
      const plan = planDatabaseMigrations(history, applied);
      if (plan.verdict === "divergent") {
        throw new DatabaseHistoryRefusalError(plan.issues);
      }
      if (plan.verdict === "ahead" && !input.allowAhead) {
        throw new DatabaseHistoryRefusalError(plan.issues);
      }
      const pending = plan.pending.map((entry) => {
        const migration = migrations[entry.idx];
        if (!migration) throw new Error(`Missing validated migration at index ${entry.idx}`);
        return { entry, migration };
      });
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
      if (plan.verdict !== "ahead") {
        for (const name of functionFiles) {
          await tx.unsafe(readFileSync(path.join(input.functionsDirectory, name), "utf8"));
        }
      }
      appliedMigrations = pending.length;
      skippedFunctions = plan.verdict === "ahead";
    });
    return { appliedMigrations, skippedFunctions };
  } finally {
    await client.end();
  }
}

export function formatDatabaseHistoryRefusal(error: DatabaseHistoryRefusalError): string {
  const details = error.issues
    .map((issue) => `  - ${formatDatabaseHistoryIssue(issue)}`)
    .join("\n");
  return `${error.message}\n${details}\nFix: This is a shared or deployed database and requires human repair. Do not reset it.`;
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
    allowAhead: false,
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
