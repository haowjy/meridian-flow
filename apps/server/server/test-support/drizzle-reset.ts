// @ts-nocheck
/**
 * Purpose: Shared destructive reset helper for Drizzle/Postgres conformance suites.
 * Key decision: DB tests need TRUNCATE CASCADE to clear throwaway schemas independent of suite order; table names are derived from Drizzle schema objects so renames fail in TypeScript instead of leaving stale SQL literals.
 */
import type { Database } from "@meridian/database";
import { getTableName, sql } from "drizzle-orm";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function truncateDrizzleTables(db: Database, tables: unknown[]): Promise<void> {
  const tableList = tables
    .map((table) => quoteIdentifier(getTableName(table as Parameters<typeof getTableName>[0])))
    .join(", ");
  // Drizzle has no TRUNCATE builder, so the raw fragment is limited to schema-derived identifiers.
  await db.execute(sql.raw(`TRUNCATE ${tableList} CASCADE`));
}
