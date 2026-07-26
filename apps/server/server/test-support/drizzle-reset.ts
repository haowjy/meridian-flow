/**
 * Purpose: Safe destructive reset helpers for Drizzle/Postgres conformance suites.
 * Key decision: Broad suites use TRUNCATE CASCADE; focused suites may delete an
 * exhaustive child-first table list. Schema-derived names keep both strategies
 * aligned with table renames.
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
 * Central safety net: refuse destructive resets outside a throwaway test DB.
 * Works off the live connection (`current_database()`), so it holds even if a
 * suite is misgated and accidentally points at the dev `postgres` database —
 * this destructive reset is what wipes `public.users` and clobbers the dev user.
 */
async function assertThrowawayDatabase(db: Database): Promise<void> {
  if (process.env.TEST_DB_ALLOW_DESTRUCTIVE === "1") return;
  const rows = (await db.execute(sql`SELECT current_database() AS name`)) as unknown as Array<{
    name?: string;
  }>;
  const dbName = rows[0]?.name ?? "";
  if (dbName === "postgres" || !dbName.toLowerCase().includes("test")) {
    throw new Error(
      `Refusing destructive database reset: connected database "${dbName}" is not a throwaway test DB. ` +
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

/**
 * Fast reset for focused suites that enumerate every table they can populate.
 * Callers must order tables child-first because this deliberately avoids a
 * graph-wide TRUNCATE CASCADE.
 */
export async function deleteDrizzleRows(db: Database, tables: unknown[]): Promise<void> {
  await assertThrowawayDatabase(db);
  const tableNames = tables.map(quoteDrizzleTable);
  await db.transaction(async (transaction) => {
    await transaction.execute(
      sql.raw(`LOCK TABLE ${tableNames.join(", ")} IN ACCESS EXCLUSIVE MODE`),
    );
    for (const tableName of tableNames) {
      await transaction.execute(sql.raw(`DELETE FROM ${tableName}`));
    }
  });
}
