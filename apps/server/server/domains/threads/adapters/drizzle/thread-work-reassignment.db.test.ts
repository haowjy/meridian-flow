/** Postgres coverage for atomic and serialized primary Work reassignment. */
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000481";
const PROJECT_ID = "00000000-0000-4000-8000-000000000482";
const THREAD_ID = "00000000-0000-4000-8000-000000000483";
const OLD_WORK_ID = "00000000-0000-4000-8000-000000000484";
const FIRST_WORK_ID = "00000000-0000-4000-8000-000000000485";
const SECOND_WORK_ID = "00000000-0000-4000-8000-000000000486";
const ADVISORY_KEY = 748_210_481;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread Work reassignment (postgres)", () => {});
} else {
  describe("thread Work reassignment (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { and, eq } = await import("drizzle-orm");
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositories } = await import("./repositories.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const threadWorks = createDrizzleRepositories(db).threadWorks;

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "work-reassignment"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Work Reassignment",
        slug: "work-reassignment",
      });
      await db.insert(schema.works).values([
        {
          id: OLD_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Old",
        },
        {
          id: FIRST_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "First",
        },
        {
          id: SECOND_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Second",
        },
      ]);
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Reassignment thread",
        kind: "primary",
        status: "idle",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: OLD_WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    afterAll(async () => {
      await control.end();
      await db.close();
    });

    async function primaryRows() {
      return db
        .select({
          workId: schema.threadWorks.workId,
          isPrimary: schema.threadWorks.isPrimary,
        })
        .from(schema.threadWorks)
        .where(
          and(eq(schema.threadWorks.threadId, THREAD_ID), eq(schema.threadWorks.isPrimary, true)),
        );
    }

    async function waitForLock(waitEvent: string): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await control<{ count: string }[]>`
          SELECT count(*)::text AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event = ${waitEvent}
        `;
        if (Number(row?.count ?? 0) > 0) return;
        await delay(10);
      }
      throw new Error(`Timed out waiting for PostgreSQL ${waitEvent} lock`);
    }

    it("rolls the demotion back when target membership persistence fails", async () => {
      await control.unsafe(`
        CREATE FUNCTION test_fail_work_reassignment() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.thread_id = '${THREAD_ID}'::uuid
            AND NEW.work_id = '${FIRST_WORK_ID}'::uuid
            AND NEW.is_primary = true
          THEN
            RAISE EXCEPTION 'injected reassignment failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_fail_work_reassignment
        BEFORE INSERT OR UPDATE ON thread_works
        FOR EACH ROW EXECUTE FUNCTION test_fail_work_reassignment();
      `);

      try {
        await expect(threadWorks.addMembership(THREAD_ID, FIRST_WORK_ID, true)).rejects.toThrow();
        await expect(primaryRows()).resolves.toEqual([{ workId: OLD_WORK_ID, isPrimary: true }]);
        await expect(threadWorks.listByThread(THREAD_ID)).resolves.toEqual([
          { workId: OLD_WORK_ID, isPrimary: true },
        ]);
      } finally {
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_fail_work_reassignment ON thread_works;
          DROP FUNCTION IF EXISTS test_fail_work_reassignment();
        `);
      }
    });

    it("serializes concurrent primary reassignments for the same thread", async () => {
      await control.unsafe(`
        CREATE FUNCTION test_block_work_reassignment() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.thread_id = '${THREAD_ID}'::uuid
            AND OLD.work_id = '${OLD_WORK_ID}'::uuid
            AND OLD.is_primary = true
            AND NEW.is_primary = false
          THEN
            PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_work_reassignment
        BEFORE UPDATE ON thread_works
        FOR EACH ROW EXECUTE FUNCTION test_block_work_reassignment();
      `);
      await control`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
      let advisoryLockHeld = true;

      try {
        const first = threadWorks.addMembership(THREAD_ID, FIRST_WORK_ID, true);
        await waitForLock("advisory");
        const second = threadWorks.addMembership(THREAD_ID, SECOND_WORK_ID, true);
        await waitForLock("transactionid");

        await expect(primaryRows()).resolves.toEqual([{ workId: OLD_WORK_ID, isPrimary: true }]);

        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

        const primary = await primaryRows();
        expect(primary).toHaveLength(1);
        expect([FIRST_WORK_ID, SECOND_WORK_ID]).toContain(primary[0]?.workId);
        await expect(threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
          workId: primary[0]?.workId,
        });
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_work_reassignment ON thread_works;
          DROP FUNCTION IF EXISTS test_block_work_reassignment();
        `);
      }
    });
  });
}
