/**
 * Purpose: Safe destructive reset helpers for Drizzle/Postgres conformance suites.
 * Key decision: Broad suites use TRUNCATE CASCADE; focused suites may delete an
 * FK-closed table set derived from the live Postgres catalog. Schema-derived
 * names keep both strategies aligned with table renames.
 */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

type CatalogTableRow = {
  table_oid: string;
  schema_name: string;
  table_name: string;
  parent_oid: string | null;
};

type TableNode = {
  oid: string;
  qualifiedName: string;
  parentOids: Set<string>;
};

function compareTableNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function drizzleTableIdentity(table: unknown): { schemaName: string; tableName: string } {
  const { schema, name } = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  return { schemaName: schema ?? "public", tableName: name };
}

function quoteTable(schemaName: string, tableName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

function quoteDrizzleTable(table: unknown): string {
  const { schemaName, tableName } = drizzleTableIdentity(table);
  return quoteTable(schemaName, tableName);
}

function childFirstTableOrder(rows: CatalogTableRow[]): TableNode[] {
  const nodes = new Map<string, TableNode>();
  for (const row of rows) {
    const node = nodes.get(row.table_oid) ?? {
      oid: row.table_oid,
      qualifiedName: quoteTable(row.schema_name, row.table_name),
      parentOids: new Set<string>(),
    };
    if (row.parent_oid) node.parentOids.add(row.parent_oid);
    nodes.set(row.table_oid, node);
  }

  const incomingChildren = new Map([...nodes.keys()].map((oid) => [oid, 0]));
  for (const node of nodes.values()) {
    for (const parentOid of node.parentOids) {
      incomingChildren.set(parentOid, (incomingChildren.get(parentOid) ?? 0) + 1);
    }
  }

  const available = [...nodes.values()]
    .filter((node) => incomingChildren.get(node.oid) === 0)
    .sort((left, right) => compareTableNames(left.qualifiedName, right.qualifiedName));
  const ordered: TableNode[] = [];
  while (available.length > 0) {
    const node = available.shift();
    if (!node) break;
    ordered.push(node);
    for (const parentOid of node.parentOids) {
      const remainingChildren = (incomingChildren.get(parentOid) ?? 0) - 1;
      incomingChildren.set(parentOid, remainingChildren);
      if (remainingChildren === 0) {
        const parent = nodes.get(parentOid);
        if (parent) {
          available.push(parent);
          available.sort((left, right) =>
            compareTableNames(left.qualifiedName, right.qualifiedName),
          );
        }
      }
    }
  }

  if (ordered.length !== nodes.size) {
    const cyclicTables = [...nodes.values()]
      .filter((node) => !ordered.includes(node))
      .map((node) => node.qualifiedName)
      .sort();
    throw new Error(
      `Cannot derive a child-first reset order because foreign keys form a cycle among: ${cyclicTables.join(", ")}`,
    );
  }
  return ordered;
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
 * Fast reset for focused suites. Supplied tables are scope anchors, not an
 * exhaustive ordering: the live Postgres FK graph recursively adds every
 * dependent table and determines the child-first delete order.
 */
export async function deleteDrizzleRows(db: Database, tables: unknown[]): Promise<void> {
  await assertThrowawayDatabase(db);
  if (tables.length === 0) throw new Error("deleteDrizzleRows requires at least one table");
  const requestedTables = tables.map(drizzleTableIdentity);
  const requestedValues = sql.join(
    requestedTables.map(({ schemaName, tableName }) => sql`(${schemaName}, ${tableName})`),
    sql.raw(", "),
  );

  await db.transaction(async (transaction) => {
    const rows = (await transaction.execute(sql`
      WITH RECURSIVE requested_tables(schema_name, table_name) AS (
        VALUES ${requestedValues}
      ),
      tables_to_clear(oid) AS (
        SELECT relation.oid
        FROM pg_catalog.pg_class AS relation
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        INNER JOIN requested_tables AS requested
          ON requested.schema_name = namespace.nspname
          AND requested.table_name = relation.relname
        WHERE relation.relkind IN ('r', 'p')

        UNION

        SELECT foreign_key.conrelid
        FROM tables_to_clear AS parent
        INNER JOIN pg_catalog.pg_constraint AS foreign_key
          ON foreign_key.confrelid = parent.oid
        WHERE foreign_key.contype = 'f'
      )
      SELECT
        relation.oid::text AS table_oid,
        namespace.nspname AS schema_name,
        relation.relname AS table_name,
        foreign_key.confrelid::text AS parent_oid
      FROM tables_to_clear
      INNER JOIN pg_catalog.pg_class AS relation
        ON relation.oid = tables_to_clear.oid
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_catalog.pg_constraint AS foreign_key
        ON foreign_key.conrelid = relation.oid
        AND foreign_key.contype = 'f'
        AND foreign_key.confrelid <> relation.oid
        AND foreign_key.confrelid IN (SELECT oid FROM tables_to_clear)
      ORDER BY namespace.nspname, relation.relname, foreign_key.confrelid
    `)) as unknown as CatalogTableRow[];
    const tableOrder = childFirstTableOrder(rows);
    const derivedNames = new Set(tableOrder.map((table) => table.qualifiedName));
    const missingTables = requestedTables
      .map(({ schemaName, tableName }) => quoteTable(schemaName, tableName))
      .filter((tableName) => !derivedNames.has(tableName));
    if (missingTables.length > 0) {
      throw new Error(
        `Reset tables are missing from the live database: ${missingTables.join(", ")}`,
      );
    }

    const lockOrder = tableOrder.map((table) => table.qualifiedName).sort(compareTableNames);
    await transaction.execute(
      sql.raw(`LOCK TABLE ${lockOrder.join(", ")} IN ACCESS EXCLUSIVE MODE`),
    );
    for (const table of tableOrder) {
      await transaction.execute(sql.raw(`DELETE FROM ${table.qualifiedName}`));
    }
  });
}
