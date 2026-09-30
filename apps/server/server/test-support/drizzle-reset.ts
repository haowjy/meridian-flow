/** Rollback isolation by default; catalog-derived DELETE for committed, multi-connection suites. */
import { createDb, type Database } from "@meridian/database";
import { promptBakes, threads } from "@meridian/database/schema";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, aroundEach, beforeAll } from "vitest";
import { processDetachedWork } from "../domains/runtime/detached-work.js";

type CatalogTableRow = {
  table_oid: string;
  schema_name: string;
  table_name: string;
  parent_oid: string | null;
  condeferrable: boolean | null;
  confdeltype: string | null;
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
    // Only deferrable NO ACTION edges can be postponed by SET CONSTRAINTS.
    if (row.parent_oid && !(row.condeferrable && row.confdeltype === "a")) {
      node.parentOids.add(row.parent_oid);
    }
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

/**
 * Fast reset for focused suites. Supplied tables are scope anchors, not an
 * exhaustive ordering: the live Postgres FK graph recursively adds every
 * dependent table and determines the child-first delete order.
 */
export async function deleteDrizzleRows(db: Database, tables: unknown[]): Promise<void> {
  if (!(await processDetachedWork.drain(25_000)))
    throw new Error(
      `Cannot reset fixtures before detached runtime work settles: ${processDetachedWork.pendingTasks.join(", ")}`,
    );
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
        foreign_key.confrelid::text AS parent_oid,
        foreign_key.condeferrable,
        foreign_key.confdeltype
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
    await transaction.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
    for (const table of tableOrder) {
      // Insert-only bakes permit deletion only through their owning thread's cascade.
      // This exemption requires the owner in the reset set; standalone bake deletes still fail.
      // A preceding suite may leave bakes even when this suite never creates one.
      if (
        table.qualifiedName === quoteDrizzleTable(promptBakes) &&
        derivedNames.has(quoteDrizzleTable(threads))
      )
        continue;
      await transaction.execute(sql.raw(`DELETE FROM ${table.qualifiedName}`));
    }
  });
}

export interface RollbackTestDatabase {
  readonly current: Database;
}

/**
 * Register transaction isolation for the current suite.
 *
 * Read `current` inside `beforeEach` or the test body. It points at the active
 * transaction while the case runs and at the root connection outside a case.
 */
export function useRollbackTestDatabase(
  databaseUrl: string,
  options?: {
    max?: number;
    /** Durable worker baseline; must be safe for later suites sharing the worker DB. */
    prepareSuite?: (db: Database) => Promise<void>;
  },
): RollbackTestDatabase {
  const root = createDb(databaseUrl, options);
  let current = root;

  if (options?.prepareSuite) {
    beforeAll(() => options.prepareSuite?.(root));
  }

  aroundEach(async (runTest) => {
    try {
      await root.transaction(async (transaction) => {
        current = transaction as unknown as Database;
        await runTest();
        transaction.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    } finally {
      current = root;
    }
  });

  afterAll(async () => {
    await root.close();
  });

  return {
    get current() {
      return current;
    },
  };
}
