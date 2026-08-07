/** Postgres regression for Work deletion racing a new thread membership. */

import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000471";
const PROJECT_ID = "00000000-0000-4000-8000-000000000472";
const THREAD_ID = "00000000-0000-4000-8000-000000000473";
const WORK_ID = "00000000-0000-4000-8000-000000000474";
const ADVISORY_KEY = 748_210_471;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread Work lifecycle serialization (postgres)", () => {});
} else {
  describe("thread Work lifecycle serialization (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { WorkDeleteBlockedError } = await import("../../../projects/index.js");
    const { createDrizzleProjectRepository, createDrizzleProjectWorkRepository } = await import(
      "../../../projects/index.js"
    );
    const { createDrizzleProjectPreferencesRepository } = await import(
      "../../../preferences/index.js"
    );
    const { createInMemoryEventSink } = await import("../../../observability/index.js");
    const { createThreadForProject } = await import("../../../../lib/thread-creation.js");
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositories } = await import("./repositories.js");
    const { eq } = await import("drizzle-orm");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const threads = createDrizzleRepositories(db);
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
    });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "work-lifecycle-race"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Work Lifecycle Race",
        slug: "work-lifecycle-race",
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Race target",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Race thread",
        kind: "primary",
        status: "idle",
      });
    });

    afterAll(async () => {
      await control.end();
      await db.close();
    });

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

    it("serializes attachment before deletion and then blocks the delete", async () => {
      await control.unsafe(`
        CREATE FUNCTION test_block_thread_work_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_thread_work_insert
        BEFORE INSERT ON thread_works
        FOR EACH ROW EXECUTE FUNCTION test_block_thread_work_insert();
      `);
      await control`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
      let advisoryLockHeld = true;

      try {
        const attach = threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
        await waitForLock("advisory");

        const deletion = works.softDelete(WORK_ID).then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        await waitForLock("transactionid");

        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await attach;

        const result = await deletion;
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(WorkDeleteBlockedError);
        }
        await expect(works.findById(WORK_ID)).resolves.toMatchObject({ deletedAt: null });
        await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
          workId: WORK_ID,
        });
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_thread_work_insert ON thread_works;
          DROP FUNCTION IF EXISTS test_block_thread_work_insert();
        `);
      }
    });

    it("creates a root conversation without self-blocking when the project has no Work", async () => {
      await db.delete(schema.threads).where(eq(schema.threads.id, THREAD_ID));
      await db.delete(schema.works).where(eq(schema.works.id, WORK_ID));
      const preferences = createDrizzleProjectPreferencesRepository({ db });

      const thread = await createThreadForProject(
        {
          projects: createDrizzleProjectRepository({ db }),
          workRepo: works,
          preferences,
          threads: threads.threads,
          threadWorks: threads.threadWorks,
          transaction: threads.transaction,
          eventSink: createInMemoryEventSink(),
        },
        {
          projectId: PROJECT_ID,
          userId: USER_ID,
          title: "First conversation",
        },
      );

      expect(thread.workId).toBeTruthy();
      await expect(preferences.getCurrentWorkId(USER_ID, PROJECT_ID)).resolves.toBe(thread.workId);
      await expect(threads.threadWorks.findPrimary(thread.id)).resolves.toEqual({
        workId: thread.workId,
      });
    });
  });
}
