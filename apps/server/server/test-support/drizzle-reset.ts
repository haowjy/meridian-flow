// @ts-nocheck
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

export async function truncateDrizzleTables(db: Database, tables: unknown[]): Promise<void> {
  const tableList = tables.map(quoteDrizzleTable).join(", ");
  // Drizzle has no TRUNCATE builder, so the raw fragment is limited to schema-derived identifiers.
  await db.execute(sql.raw(`TRUNCATE ${tableList} CASCADE`));
}
