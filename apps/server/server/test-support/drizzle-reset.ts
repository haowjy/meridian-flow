/**
 * Purpose: Shared destructive reset helper for Drizzle/Postgres conformance suites.
 * Key decision: DB tests need TRUNCATE CASCADE to clear throwaway schemas independent of suite order; table names are derived from Drizzle schema objects so renames fail in TypeScript instead of leaving stale SQL literals.
 */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteDrizzleTable(table: unknown): string {
  const { schema, name } = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  const quotedName = quoteIdentifier(name);
  return schema ? `${quoteIdentifier(schema)}.${quotedName}` : quotedName;
}

/**
 * Central safety net: refuse to TRUNCATE anything but a throwaway test DB.
 * Works off the live connection (`current_database()`), so it holds even if a
 * suite is misgated and accidentally points at the dev `postgres` database —
 * this destructive reset is what wipes `auth.users` and clobbers the dev user.
 */
async function assertThrowawayDatabase(db: Database): Promise<void> {
  if (process.env.TEST_DB_ALLOW_DESTRUCTIVE === "1") return;
  const rows = (await db.execute(sql`SELECT current_database() AS name`)) as unknown as Array<{
    name?: string;
  }>;
  const dbName = rows[0]?.name ?? "";
  if (dbName === "postgres" || !dbName.toLowerCase().includes("test")) {
    throw new Error(
      `Refusing destructive TRUNCATE: connected database "${dbName}" is not a throwaway test DB. ` +
        'Its name must contain "test" and must not be the dev "postgres" DB. ' +
        "Point DATABASE_URL at a dedicated throwaway DB, or set TEST_DB_ALLOW_DESTRUCTIVE=1.",
    );
  }
}

export async function truncateDrizzleTables(db: Database, tables: unknown[]): Promise<void> {
  await assertThrowawayDatabase(db);
  const tableList = tables.map(quoteDrizzleTable).join(", ");
  // Drizzle has no TRUNCATE builder, so the raw fragment is limited to schema-derived identifiers.
  await db.execute(sql.raw(`TRUNCATE ${tableList} CASCADE`));
}
