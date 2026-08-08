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
const TARGET_WORK_ID = "00000000-0000-4000-8000-000000000475";
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
    const { applyRebindThreadWorkTransition, rebindThreadWork } = await import(
      "../../domain/rebind-thread-work.js"
    );
    const { createDrizzleThreadRunOwnership } = await import(
      "../../../runtime/adapters/drizzle-thread-run-ownership.js"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleBranchStore } = await import(
      "../../../collab/adapters/drizzle-branches.js"
    );
    const { createDrizzleWorkDraftPendingStore } = await import(
      "../../../collab/adapters/drizzle-branch-push.js"
    );
    const { createWorkDraftPending } = await import("../../../collab/domain/work-draft-pending.js");
    const { createDrizzleRepositories } = await import("./repositories.js");
    const { eq } = await import("drizzle-orm");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const threads = createDrizzleRepositories(db);
    const draftPending = createWorkDraftPending(createDrizzleWorkDraftPendingStore(db));
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async (workId) => (await draftPending.count(workId)) > 0,
    });
    const branches = createDrizzleBranchStore(db, undefined);
    const CONTEXT_ID = "00000000-0000-4000-8000-000000000476";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000477";
    const BRANCH_ID = "branch_work_lifecycle_race";

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
        slug: "race-target",
      });
      await db.insert(schema.works).values({
        id: TARGET_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Rebound target",
        slug: "rebound-target",
        status: "archived",
        archivedAt: new Date(),
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Race thread",
        kind: "primary",
        status: "idle",
      });
      await db.insert(schema.contextSources).values({
        id: CONTEXT_ID,
        projectId: PROJECT_ID,
        name: "Project context",
        slug: "project-context",
      });
      await db.insert(schema.documents).values({
        id: DOCUMENT_ID,
        contextSourceId: CONTEXT_ID,
        name: "Draft target",
      });
      await db.insert(schema.documentBranches).values({
        id: BRANCH_ID,
        documentId: DOCUMENT_ID,
        kind: "work_draft",
        workId: WORK_ID,
        state: Buffer.alloc(0),
        stateVector: Buffer.alloc(0),
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

    it("replaces the primary membership, preserves one primary, and accepts archived targets", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      await threads.threadWorks.addMembership(THREAD_ID, TARGET_WORK_ID, false);

      await expect(threads.threadWorks.rebindPrimary(THREAD_ID, TARGET_WORK_ID)).resolves.toEqual({
        previousWorkId: WORK_ID,
        changed: true,
      });
      await expect(threads.threadWorks.rebindPrimary(THREAD_ID, TARGET_WORK_ID)).resolves.toEqual({
        previousWorkId: TARGET_WORK_ID,
        changed: false,
      });
      await expect(threads.threadWorks.listByThread(THREAD_ID)).resolves.toEqual([
        { workId: TARGET_WORK_ID, isPrimary: true },
      ]);
    });

    it("commits binding, sticky preference, and durable context obligation atomically", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const preferences = createDrizzleProjectPreferencesRepository({ db });

      const result = await rebindThreadWork(
        {
          threads: threads.threads,
          threadWorks: threads.threadWorks,
          works,
          preferences,
          contextUpdates: {
            threadChanged: async (threadId) => {
              await threads.workContextDeliveries.enqueueThread(threadId);
            },
            flush: async () => {},
            isPending: (threadId) => threads.workContextDeliveries.isPending(threadId),
          },
          transaction: threads.transaction,
        },
        {
          threadId: THREAD_ID,
          targetWorkId: TARGET_WORK_ID,
          preferenceUserId: USER_ID,
        },
      );

      expect(result).toMatchObject({ changed: true, contextUpdate: "pending" });
      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: TARGET_WORK_ID,
      });
      await expect(preferences.getCurrentWorkId(USER_ID, PROJECT_ID)).resolves.toBe(TARGET_WORK_ID);
      await expect(threads.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
    });

    it("excludes a writer rebind while another server instance owns the run", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const preferences = createDrizzleProjectPreferencesRepository({ db });
      const modelInstance = createDrizzleThreadRunOwnership(db);
      const writerInstance = createDrizzleThreadRunOwnership(db);
      const modelClaim = await modelInstance.tryAcquire(THREAD_ID);
      expect(modelClaim).not.toBeNull();

      expect(await writerInstance.tryAcquire(THREAD_ID)).toBeNull();
      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: WORK_ID,
      });

      await modelClaim?.release();
      const writerClaim = await writerInstance.tryAcquire(THREAD_ID);
      expect(writerClaim).not.toBeNull();
      try {
        await threads.transaction(() =>
          applyRebindThreadWorkTransition(
            {
              threads: threads.threads,
              threadWorks: threads.threadWorks,
              works,
              preferences,
              contextUpdates: {
                threadChanged: (threadId) =>
                  threads.workContextDeliveries.enqueueThread(threadId).then(() => undefined),
              },
            },
            {
              threadId: THREAD_ID,
              targetWorkId: TARGET_WORK_ID,
              preferenceUserId: USER_ID,
            },
          ),
        );
      } finally {
        await writerClaim?.release();
      }

      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: TARGET_WORK_ID,
      });
    });

    it("rolls back binding and sticky preference when durable enqueue fails", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const preferences = createDrizzleProjectPreferencesRepository({ db });

      await expect(
        rebindThreadWork(
          {
            threads: threads.threads,
            threadWorks: threads.threadWorks,
            works,
            preferences,
            contextUpdates: {
              threadChanged: async () => {
                throw new Error("injected durable enqueue failure");
              },
              flush: async () => {},
              isPending: async () => false,
            },
            transaction: threads.transaction,
          },
          {
            threadId: THREAD_ID,
            targetWorkId: TARGET_WORK_ID,
            preferenceUserId: USER_ID,
          },
        ),
      ).rejects.toThrow("injected durable enqueue failure");
      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: WORK_ID,
      });
      await expect(preferences.getCurrentWorkId(USER_ID, PROJECT_ID)).resolves.toBeNull();
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
        await expect(threads.threadWorks.listByThread(THREAD_ID)).resolves.toEqual([
          { workId: WORK_ID, isPrimary: true },
        ]);
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_primary_demote ON thread_works;
          DROP FUNCTION IF EXISTS test_block_primary_demote();
        `);
      }
    });

    it("blocks deletion when a draft transition takes the lifecycle lock first", async () => {
      await control.unsafe(`
        CREATE FUNCTION test_block_draft_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_draft_insert
        BEFORE INSERT ON branch_write_journal
        FOR EACH ROW EXECUTE FUNCTION test_block_draft_insert();
      `);
      await control`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
      let advisoryLockHeld = true;
      try {
        const draft = branches.appendJournal?.({
          branchId: BRANCH_ID,
          generation: 1,
          updateData: new Uint8Array([1]),
          source: "agent",
        });
        if (!draft) throw new Error("Branch journal append is unavailable");
        await waitForLock("advisory");
        const deletion = works.softDelete(WORK_ID).then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        await waitForLock("transactionid");
        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await draft;
        const result = await deletion;
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ reason: "drafts" });
        }
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_draft_insert ON branch_write_journal;
          DROP FUNCTION IF EXISTS test_block_draft_insert();
        `);
      }
    });

    it("deletes first and then refuses a draft transition under that Work", async () => {
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
        const draft = branches.appendJournal?.({
          branchId: BRANCH_ID,
          generation: 1,
          updateData: new Uint8Array([1]),
          source: "agent",
        });
        if (!draft) throw new Error("Branch journal append is unavailable");
        await waitForLock("transactionid");
        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await deletion;
        await expect(draft).rejects.toThrow(`Work not found: ${WORK_ID}`);
        await expect(draftPending.count(WORK_ID)).resolves.toBe(0);
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_work_delete ON works;
          DROP FUNCTION IF EXISTS test_block_work_delete();
        `);
      }
    });

    it("serializes rebind before target deletion and then blocks the delete", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      await control.unsafe(`
        CREATE FUNCTION test_block_thread_work_rebind() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_KEY});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_thread_work_rebind
        BEFORE UPDATE ON thread_works
        FOR EACH ROW WHEN (OLD.work_id IS DISTINCT FROM NEW.work_id)
        EXECUTE FUNCTION test_block_thread_work_rebind();
      `);
      await control`SELECT pg_advisory_lock(${ADVISORY_KEY})`;
      let advisoryLockHeld = true;

      try {
        const rebind = threads.threadWorks.rebindPrimary(THREAD_ID, TARGET_WORK_ID);
        await waitForLock("advisory");
        const deletion = works.softDelete(TARGET_WORK_ID).then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        await waitForLock("transactionid");

        await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        advisoryLockHeld = false;
        await expect(rebind).resolves.toMatchObject({ changed: true });
        const result = await deletion;
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(WorkDeleteBlockedError);
        }
        await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
          workId: TARGET_WORK_ID,
        });
        await expect(works.findById(TARGET_WORK_ID)).resolves.toMatchObject({ deletedAt: null });
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${ADVISORY_KEY})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_thread_work_rebind ON thread_works;
          DROP FUNCTION IF EXISTS test_block_thread_work_rebind();
        `);
      }
    });

    it("creates a root conversation without self-blocking when the project has no Work", async () => {
      await db.delete(schema.threads).where(eq(schema.threads.id, THREAD_ID));
      await db.delete(schema.documentBranches).where(eq(schema.documentBranches.id, BRANCH_ID));
      await db.delete(schema.works).where(eq(schema.works.id, WORK_ID));
      await db.delete(schema.works).where(eq(schema.works.id, TARGET_WORK_ID));
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
