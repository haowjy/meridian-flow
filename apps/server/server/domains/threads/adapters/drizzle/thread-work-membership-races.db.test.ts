/** PostgreSQL coverage for thread Work membership and lifecycle serialization. */

import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestWorkProjectionMutation } from "../../../../test-support/work-projection.js";
import { createDrizzleLineageScratchLifecycle } from "../../../context/adapters/lineage-scratch-lifecycle.js";
import { createLocalFileAccessChanges } from "../../../file-policy/index.js";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../../test-support/thread-work-postgres-harness.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const {
  threadId: THREAD_ID,
  workId: WORK_ID,
  targetWorkId: TARGET_WORK_ID,
  draftId: DRAFT_ID,
} = THREAD_WORK_RACE;
const ADVISORY_KEY = 748_210_471;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread Work membership races (postgres)", () => {});
} else {
  describe("thread Work membership races (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { eq } = await import("drizzle-orm");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDrizzleProjectWorkRepository, deleteWorkTransition } = await import(
      "../../../projects/index.js"
    );
    const { createDrizzleDraftStore } = await import("../../../collab/adapters/drizzle-drafts.js");
    const { createDrizzleBranchStore } = await import(
      "../../../collab/adapters/drizzle-branches.js"
    );
    const { appendDraftRows, proseDraftUpdate } = await import(
      "../../../collab/test-support/draft-store-seam.js"
    );
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const threads = createDrizzleRepositoriesForTest(db);
    const works = createDrizzleProjectWorkRepository({
      lineageScratch: createDrizzleLineageScratchLifecycle(db),
      db,
      fileAccessChanges: createLocalFileAccessChanges(),
      projectionMutation: createTestWorkProjectionMutation(db),
    });
    const drafts = createDrizzleDraftStore(db, {
      workProjection: createTestWorkProjectionMutation(db),
      branches: createDrizzleBranchStore(db),
    });

    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
      await db
        .update(schema.works)
        .set({ archivedAt: null })
        .where(eq(schema.works.id, TARGET_WORK_ID));
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

    it("serializes attachment before deletion and hides the newly bound thread", async () => {
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

        const deletion = deleteWorkTransition(
          {
            works,
            stopThreadRun: async () => {},
          },
          WORK_ID,
        ).then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        await waitForLock("transactionid");

        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await attach;

        const result = await deletion;
        expect(result.status).toBe("fulfilled");
        await expect(works.findById(WORK_ID)).resolves.toMatchObject({
          deletedAt: expect.any(String),
        });
        await expect(threads.threads.findById(THREAD_ID)).resolves.toBeNull();
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

    it("serializes competing primary add and rebind without reversing Work/thread locks", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      await control.unsafe(`
        CREATE FUNCTION test_block_primary_demote() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_primary_demote
        BEFORE UPDATE ON thread_works
        FOR EACH ROW WHEN (OLD.is_primary AND NOT NEW.is_primary)
        EXECUTE FUNCTION test_block_primary_demote();
      `);
      await control`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
      let advisoryLockHeld = true;

      try {
        const add = threads.threadWorks.addMembership(THREAD_ID, TARGET_WORK_ID, true);
        await waitForLock("advisory");
        const rebind = threads.threadWorks.rebindPrimary(THREAD_ID, WORK_ID);
        await waitForLock("transactionid");
        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await Promise.all([add, rebind]);
        const memberships = await threads.threadWorks.listByThread(THREAD_ID);
        expect(memberships).toHaveLength(2);
        expect(memberships).toEqual(
          expect.arrayContaining([
            { workId: WORK_ID, isPrimary: true },
            { workId: TARGET_WORK_ID, isPrimary: false },
          ]),
        );
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_primary_demote ON thread_works;
          DROP FUNCTION IF EXISTS test_block_primary_demote();
        `);
      }
    });

    it("an append is not held behind a Work deletion, and the next one is refused after it", async () => {
      await control.unsafe(`
        CREATE FUNCTION test_block_work_delete() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_work_delete
        BEFORE UPDATE ON works
        FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
        EXECUTE FUNCTION test_block_work_delete();
      `);
      await control`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
      let advisoryLockHeld = true;
      try {
        const deletion = works.softDelete(WORK_ID);
        await waitForLock("advisory");
        // An append locks no Work (phase 4): it is not held behind the deletion, and one that
        // started before the deletion committed lands (the archive window, design §5).
        await expect(
          appendDraftRows(drafts, DRAFT_ID, [{ updateData: proseDraftUpdate(), source: "agent" }]),
        ).resolves.toHaveLength(1);
        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await deletion;
        // Once the deletion committed, the append's Work-is-active predicate refuses the next.
        await expect(
          appendDraftRows(drafts, DRAFT_ID, [
            { updateData: proseDraftUpdate("after"), source: "agent" },
          ]),
        ).rejects.toThrow(/append was refused/);
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_work_delete ON works;
          DROP FUNCTION IF EXISTS test_block_work_delete();
        `);
      }
    });

    it("serializes rebind before target deletion and hides the rebound thread", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      await control.unsafe(`
        CREATE FUNCTION test_block_thread_work_rebind_demote() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_thread_work_rebind
        BEFORE UPDATE ON thread_works
        FOR EACH ROW WHEN (OLD.is_primary AND NOT NEW.is_primary)
        EXECUTE FUNCTION test_block_thread_work_rebind_demote();
      `);
      await control`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
      let advisoryLockHeld = true;

      try {
        const rebind = threads.threadWorks.rebindPrimary(THREAD_ID, TARGET_WORK_ID);
        await waitForLock("advisory");
        const deletion = deleteWorkTransition(
          {
            works,
            stopThreadRun: async () => {},
          },
          TARGET_WORK_ID,
        ).then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        await waitForLock("transactionid");

        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await expect(rebind).resolves.toMatchObject({ changed: true });
        const result = await deletion;
        expect(result.status).toBe("fulfilled");
        await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
          workId: TARGET_WORK_ID,
        });
        await expect(works.findById(TARGET_WORK_ID)).resolves.toMatchObject({
          deletedAt: expect.any(String),
        });
        await expect(threads.threads.findById(THREAD_ID)).resolves.toBeNull();
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_thread_work_rebind ON thread_works;
          DROP FUNCTION IF EXISTS test_block_thread_work_rebind_demote();
        `);
      }
    });

    it("deletion wins the thread lock and the waiting rebind refuses the deleted thread", async () => {
      await control.unsafe(`
        CREATE FUNCTION test_block_thread_delete() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_thread_delete
        BEFORE UPDATE ON threads
        FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
        EXECUTE FUNCTION test_block_thread_delete();
      `);
      await control`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
      let advisoryLockHeld = true;
      try {
        const deletion = (async () => {
          await db
            .update(schema.threads)
            .set({ deletedAt: new Date() })
            .where(eq(schema.threads.id, THREAD_ID));
        })();
        await waitForLock("advisory");
        const rebind = threads.threadWorks.rebindPrimary(THREAD_ID, TARGET_WORK_ID);
        await waitForLock("transactionid");
        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await deletion;
        await expect(rebind).rejects.toMatchObject({ name: "ThreadMembershipUnavailableError" });
        await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toBeNull();
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_thread_delete ON threads;
          DROP FUNCTION IF EXISTS test_block_thread_delete();
        `);
      }
    });

    it("rebind wins the thread lock before deletion and commits one primary", async () => {
      await control.unsafe(`
        CREATE FUNCTION test_block_rebind_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_rebind_insert
        BEFORE INSERT ON thread_works
        FOR EACH ROW EXECUTE FUNCTION test_block_rebind_insert();
      `);
      await control`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
      let advisoryLockHeld = true;
      try {
        const rebind = threads.threadWorks.rebindPrimary(THREAD_ID, TARGET_WORK_ID);
        await waitForLock("advisory");
        const deletion = (async () => {
          await db
            .update(schema.threads)
            .set({ deletedAt: new Date() })
            .where(eq(schema.threads.id, THREAD_ID));
        })();
        await waitForLock("transactionid");
        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await expect(rebind).resolves.toMatchObject({ changed: true });
        await deletion;
        await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
          workId: TARGET_WORK_ID,
        });
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_rebind_insert ON thread_works;
          DROP FUNCTION IF EXISTS test_block_rebind_insert();
        `);
      }
    });
  });
}
