/** Real-Postgres contract coverage for catalog-derived destructive test resets. */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { integer, pgSchema } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Drizzle reset graph (postgres)", () => {});
} else {
  describe("Drizzle reset graph (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { eventJournal, projects, threads, turns, users } = await import(
      "@meridian/database/schema"
    );
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows, truncateDrizzleTables } = await import("./drizzle-reset.js");

    const testSchema = pgSchema("drizzle_reset_test");
    const parent = testSchema.table("parent", { id: integer("id").primaryKey() });
    const mid = testSchema.table("mid", { id: integer("id").primaryKey() });
    const leaf = testSchema.table("leaf", { id: integer("id").primaryKey() });
    const diamond = testSchema.table("diamond", { id: integer("id").primaryKey() });
    const selfReference = testSchema.table("self_reference", {
      id: integer("id").primaryKey(),
    });
    const unrelated = testSchema.table("unrelated", { id: integer("id").primaryKey() });
    const cycleA = testSchema.table("cycle_a", { id: integer("id").primaryKey() });
    const cycleB = testSchema.table("cycle_b", { id: integer("id").primaryKey() });
    const missing = testSchema.table("missing", { id: integer("id").primaryKey() });
    const quotedSchema = pgSchema("reset schema");
    const quotedRoot = quotedSchema.table('root "table"', { id: integer("id").primaryKey() });

    const db = createDb(DATABASE_URL, { max: 4 });

    beforeAll(async () => {
      await db.execute(sql.raw('CREATE SCHEMA "drizzle_reset_test"'));
      await db.execute(
        sql.raw('CREATE TABLE "drizzle_reset_test"."parent" (id integer PRIMARY KEY)'),
      );
      await db.execute(
        sql.raw(
          'CREATE TABLE "drizzle_reset_test"."mid" (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES "drizzle_reset_test"."parent"(id))',
        ),
      );
      await db.execute(
        sql.raw(
          'CREATE TABLE "drizzle_reset_test"."leaf" (id integer PRIMARY KEY, mid_id integer NOT NULL REFERENCES "drizzle_reset_test"."mid"(id))',
        ),
      );
      await db.execute(
        sql.raw(
          'CREATE TABLE "drizzle_reset_test"."diamond" (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES "drizzle_reset_test"."parent"(id), mid_id integer NOT NULL REFERENCES "drizzle_reset_test"."mid"(id))',
        ),
      );
      await db.execute(
        sql.raw(
          'CREATE TABLE "drizzle_reset_test"."self_reference" (id integer PRIMARY KEY, parent_id integer REFERENCES "drizzle_reset_test"."self_reference"(id))',
        ),
      );
      await db.execute(
        sql.raw('CREATE TABLE "drizzle_reset_test"."unrelated" (id integer PRIMARY KEY)'),
      );
      await db.execute(
        sql.raw(
          'CREATE TABLE "drizzle_reset_test"."cycle_a" (id integer PRIMARY KEY, cycle_b_id integer)',
        ),
      );
      await db.execute(
        sql.raw(
          'CREATE TABLE "drizzle_reset_test"."cycle_b" (id integer PRIMARY KEY, cycle_a_id integer REFERENCES "drizzle_reset_test"."cycle_a"(id))',
        ),
      );
      await db.execute(
        sql.raw(
          'ALTER TABLE "drizzle_reset_test"."cycle_a" ADD CONSTRAINT cycle_a_cycle_b_fk FOREIGN KEY (cycle_b_id) REFERENCES "drizzle_reset_test"."cycle_b"(id)',
        ),
      );
      await db.execute(
        sql.raw(
          `CREATE FUNCTION "drizzle_reset_test".reject_parent_delete() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'parent delete rejected';
          END
          $$`,
        ),
      );
      await db.execute(sql.raw('CREATE SCHEMA "reset schema"'));
      await db.execute(
        sql.raw('CREATE TABLE "reset schema"."root ""table""" (id integer PRIMARY KEY)'),
      );
      await db.execute(
        sql.raw(
          'CREATE TABLE "reset schema"."child table" (id integer PRIMARY KEY, root_id integer NOT NULL REFERENCES "reset schema"."root ""table"""(id))',
        ),
      );
    });

    beforeEach(async () => {
      await db.execute(
        sql.raw(
          'TRUNCATE "drizzle_reset_test"."parent", "drizzle_reset_test"."self_reference", "drizzle_reset_test"."unrelated" CASCADE',
        ),
      );
      await db.execute(sql.raw('TRUNCATE "reset schema"."root ""table""" CASCADE'));
      await db.execute(
        sql.raw('DROP TRIGGER IF EXISTS reject_delete ON "drizzle_reset_test"."parent"'),
      );
    });

    afterAll(async () => {
      await db.execute(sql.raw('DROP SCHEMA "drizzle_reset_test" CASCADE'));
      await db.execute(sql.raw('DROP SCHEMA "reset schema" CASCADE'));
      await db.$client.end();
    });

    it("derives event_journal from turns and preserves its parent thread", async () => {
      await truncateDrizzleTables(db, [users]);
      const userId = randomUUID();
      const projectId = randomUUID();
      const threadId = randomUUID();
      const turnId = randomUUID();
      try {
        await db.insert(users).values(conformanceUserValues(userId, "reset-graph"));
        await db.insert(projects).values({
          id: projectId,
          userId,
          name: "Reset graph",
          slug: `reset-graph-${randomUUID()}`,
        });
        await db.insert(threads).values({
          id: threadId,
          projectId,
          createdByUserId: userId,
          title: "Reset graph",
        });
        await db.insert(turns).values({
          id: turnId,
          threadId,
          role: "assistant",
          status: "complete",
        });
        await db.insert(eventJournal).values({
          threadId,
          turnId,
          seq: 1n,
          eventType: "run.started",
          payload: { source: "reset-test" },
        });

        await deleteDrizzleRows(db, [turns]);

        await expect(db.select().from(eventJournal)).resolves.toEqual([]);
        await expect(db.select().from(turns)).resolves.toEqual([]);
        await expect(db.select({ id: threads.id }).from(threads)).resolves.toEqual([
          { id: threadId },
        ]);
      } finally {
        await truncateDrizzleTables(db, [users]);
      }
    });

    it("deletes the transitive diamond closure without deleting unrelated tables", async () => {
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."parent" VALUES (1)'));
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."mid" VALUES (2, 1)'));
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."leaf" VALUES (3, 2)'));
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."diamond" VALUES (4, 1, 2)'));
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."unrelated" VALUES (5)'));

      await deleteDrizzleRows(db, [parent]);

      await expect(db.select().from(parent)).resolves.toEqual([]);
      await expect(db.select().from(mid)).resolves.toEqual([]);
      await expect(db.select().from(leaf)).resolves.toEqual([]);
      await expect(db.select().from(diamond)).resolves.toEqual([]);
      await expect(db.select().from(unrelated)).resolves.toEqual([{ id: 5 }]);
    });

    it("deletes all rows from a self-referencing table", async () => {
      await db.execute(
        sql.raw('INSERT INTO "drizzle_reset_test"."self_reference" VALUES (1, NULL)'),
      );
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."self_reference" VALUES (2, 1)'));

      await deleteDrizzleRows(db, [selfReference]);

      await expect(db.select().from(selfReference)).resolves.toEqual([]);
    });

    it("quotes schema and table identifiers derived from the catalog", async () => {
      await db.execute(sql.raw('INSERT INTO "reset schema"."root ""table""" VALUES (1)'));
      await db.execute(sql.raw('INSERT INTO "reset schema"."child table" VALUES (2, 1)'));

      await deleteDrizzleRows(db, [quotedRoot]);

      const rows = await db.execute(sql.raw('SELECT * FROM "reset schema"."child table"'));
      expect(rows).toEqual([]);
      await expect(db.select().from(quotedRoot)).resolves.toEqual([]);
    });

    it("fails closed for missing anchors and cross-table FK cycles", async () => {
      await expect(deleteDrizzleRows(db, [missing])).rejects.toThrow(
        'Reset tables are missing from the live database: "drizzle_reset_test"."missing"',
      );
      await expect(deleteDrizzleRows(db, [cycleA, cycleB])).rejects.toThrow(
        "foreign keys form a cycle",
      );
    });

    it("rolls back child deletes when a later parent delete fails", async () => {
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."parent" VALUES (1)'));
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."mid" VALUES (2, 1)'));
      await db.execute(
        sql.raw(
          'CREATE TRIGGER reject_delete BEFORE DELETE ON "drizzle_reset_test"."parent" FOR EACH STATEMENT EXECUTE FUNCTION "drizzle_reset_test".reject_parent_delete()',
        ),
      );

      await expect(deleteDrizzleRows(db, [parent])).rejects.toThrow(
        'Failed query: DELETE FROM "drizzle_reset_test"."parent"',
      );

      await expect(db.select().from(parent)).resolves.toEqual([{ id: 1 }]);
      const midRows = await db.execute(
        sql.raw('SELECT id FROM "drizzle_reset_test"."mid" ORDER BY id'),
      );
      expect(midRows).toEqual([{ id: 2 }]);
    });

    it("serializes concurrent resets regardless of anchor order", async () => {
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."parent" VALUES (1)'));
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."mid" VALUES (2, 1)'));
      await db.execute(sql.raw('INSERT INTO "drizzle_reset_test"."unrelated" VALUES (3)'));

      await Promise.all([
        deleteDrizzleRows(db, [parent, unrelated]),
        deleteDrizzleRows(db, [unrelated, parent]),
      ]);

      await expect(db.select().from(parent)).resolves.toEqual([]);
      await expect(db.select().from(mid)).resolves.toEqual([]);
      await expect(db.select().from(unrelated)).resolves.toEqual([]);
    });
  });
}
