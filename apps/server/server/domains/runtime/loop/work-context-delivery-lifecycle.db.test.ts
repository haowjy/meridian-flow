/** PostgreSQL repository and lifecycle coverage for Work-context delivery obligations. */

import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { testWorkSlug } from "../../../test-support/work-slug.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000711";
const PROJECT_ID = "00000000-0000-4000-8000-000000000712";
const THREAD_ID = "00000000-0000-4000-8000-000000000713";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000714";
const HIDDEN_PROJECT_ID = "00000000-0000-4000-8000-000000000715";
const HIDDEN_THREAD_ID = "00000000-0000-4000-8000-000000000716";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000717";
const HISTORICAL_WORK_ID = "00000000-0000-4000-8000-000000000718";
const RECLAIMED_WORK_ID = "00000000-0000-4000-8000-000000000719";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Work-context repository and lifecycle (postgres)", () => {});
} else {
  describe("Work-context repository and lifecycle (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { count, eq } = await import("drizzle-orm");
    const {
      createDrizzleProjectRepository,
      createDrizzleProjectWorkAuthorityResolver,
      createDrizzleProjectWorkRepository,
      WorkDeleteBlockedError,
    } = await import("../../projects/index.js");
    const {
      createDrizzleEventJournalWriter,
      deleteOwnedThreadToTrash,
      restoreOwnedThreadFromTrash,
    } = await import("../../threads/index.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../../threads/adapters/drizzle/index.js"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createWorkContextDelivery } = await import("./work-context-delivery.js");
    const { createDrizzleThreadRunOwnership } = await import(
      "../adapters/drizzle-thread-run-ownership.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 6 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const sharedRunOwnership = createDrizzleThreadRunOwnership(db);
    const projects = createDrizzleProjectRepository({ db });
    const workAuthorityResolver = createDrizzleProjectWorkAuthorityResolver(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "work-context-delivery"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Work Context Delivery",
        slug: "work-context-delivery",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Frozen thread",
        bakedSkillSlugs: [],
        composedSystemPrompt: "Frozen prompt",
      });
      await db.insert(schema.threads).values({
        id: OTHER_THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Other frozen thread",
        bakedSkillSlugs: [],
        composedSystemPrompt: "Frozen prompt",
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
        if (Number(row?.count ?? 0) >= 1) return;
        await delay(10);
      }
      throw new Error(`Timed out waiting for a PostgreSQL ${waitEvent} lock`);
    }

    function delivery(
      repos: ReturnType<typeof createDrizzleRepositoriesForTest>,
      eventWriter = createDrizzleEventJournalWriter(db),
      runOwnership = sharedRunOwnership,
    ) {
      return createWorkContextDelivery({
        repos,
        eventWriter,
        workContext: {
          async renderForThread() {
            return {
              text: "<work_context>current state</work_context>",
              current: {
                projectId: "00000000-0000-0000-0000-000000000001",
                execution: {
                  scope: {
                    kind: "work",
                    workId: "00000000-0000-0000-0000-000000000002",
                    workSlug: testWorkSlug("test-work"),
                  },
                  aiWriteMode: "direct",
                  draftOwner: null,
                },
              },
            };
          },
        },
        isThreadRunning: () => false,
        runOwnership,
        schedulePostCommit() {},
      });
    }

    it("rolls enqueue back with its transaction and coalesces repeated requests", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      await expect(
        repos.transaction(async () => {
          await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
          throw new Error("business mutation rolled back");
        }),
      ).rejects.toThrow("business mutation rolled back");
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);

      await repos.transaction(async () => {
        await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
        await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
      });
      const [row] = await db
        .select({ value: count() })
        .from(schema.workContextDeliveryObligations)
        .where(eq(schema.workContextDeliveryObligations.threadId, THREAD_ID));
      expect(row?.value).toBe(1);
    });

    it("uses canonical deliverability for direct enqueue, project enqueue, and pending selection", async () => {
      await db.insert(schema.projects).values({
        id: HIDDEN_PROJECT_ID,
        userId: USER_ID,
        name: "Deleted project",
        slug: "deleted-project",
        deletedAt: new Date(),
      });
      await db.insert(schema.threads).values({
        id: HIDDEN_THREAD_ID,
        projectId: HIDDEN_PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Project-hidden thread",
        bakedSkillSlugs: null,
      });
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, OTHER_THREAD_ID));
      const repos = createDrizzleRepositoriesForTest(db);

      await expect(repos.workContextDeliveries.enqueueThread(OTHER_THREAD_ID)).resolves.toEqual([]);
      await expect(repos.workContextDeliveries.enqueueThread(HIDDEN_THREAD_ID)).resolves.toEqual(
        [],
      );
      await expect(repos.workContextDeliveries.enqueueProject(PROJECT_ID)).resolves.toEqual([
        THREAD_ID,
      ]);
      await expect(repos.workContextDeliveries.enqueueProject(HIDDEN_PROJECT_ID)).resolves.toEqual(
        [],
      );
      await expect(repos.workContextDeliveries.listPendingThreadIds()).resolves.toEqual([
        THREAD_ID,
      ]);
      await expect(repos.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(false);
      await expect(repos.workContextDeliveries.isPending(HIDDEN_THREAD_ID)).resolves.toBe(false);
    });

    it("parks obligations across thread deletion and resumes one current delivery after restore", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, OTHER_THREAD_ID));

      await expect(repos.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(true);
      await expect(repos.workContextDeliveries.listPendingThreadIds()).resolves.toEqual([
        THREAD_ID,
      ]);
      await expect(delivery(repos).sweep()).resolves.toBeUndefined();
      await expect(delivery(repos).sweep()).resolves.toBeUndefined();
      await expect(repos.turns.listByThread(THREAD_ID)).resolves.toHaveLength(1);
      await expect(repos.turns.listByThread(OTHER_THREAD_ID)).resolves.toHaveLength(0);
      await expect(repos.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(true);

      await restoreOwnedThreadFromTrash(
        {
          repos,
          projects,
          workAuthorityResolver,
          obligations: repos.workContextDeliveries,
          workContextDelivery: delivery(repos),
        },
        OTHER_THREAD_ID,
        USER_ID,
      );
      await delivery(repos).sweep();
      await expect(repos.turns.listByThread(OTHER_THREAD_ID)).resolves.toHaveLength(1);
      await expect(repos.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(false);
    });

    it("parks obligations across project deletion and resumes after restore", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      await repos.workContextDeliveries.enqueueThread(THREAD_ID);
      await db
        .update(schema.projects)
        .set({ deletedAt: new Date() })
        .where(eq(schema.projects.id, PROJECT_ID));

      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
      await expect(repos.workContextDeliveries.listPendingThreadIds()).resolves.toEqual([]);
      await expect(delivery(repos).sweep()).resolves.toBeUndefined();
      await expect(delivery(repos).sweep()).resolves.toBeUndefined();
      await expect(repos.turns.listByThread(THREAD_ID)).resolves.toHaveLength(0);

      await db
        .update(schema.projects)
        .set({ deletedAt: null })
        .where(eq(schema.projects.id, PROJECT_ID));
      await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
      await delivery(repos).sweep();
      await expect(repos.turns.listByThread(THREAD_ID)).resolves.toHaveLength(1);
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);
    });

    it("targets a restored thread when Work changed only while it was hidden", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, OTHER_THREAD_ID));

      await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
      await expect(repos.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(false);
      await repos.workContextDeliveries.acknowledge(THREAD_ID);

      await restoreOwnedThreadFromTrash(
        {
          repos,
          projects,
          workAuthorityResolver,
          obligations: repos.workContextDeliveries,
          workContextDelivery: delivery(repos),
        },
        OTHER_THREAD_ID,
        USER_ID,
      );
      await expect(repos.turns.listByThread(OTHER_THREAD_ID)).resolves.toHaveLength(1);
      await expect(repos.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(false);
    });

    it("makes sequential restore retries one visibility transition and one delivery", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, OTHER_THREAD_ID));
      const restore = () =>
        restoreOwnedThreadFromTrash(
          {
            repos,
            projects,
            workAuthorityResolver,
            obligations: repos.workContextDeliveries,
            workContextDelivery: delivery(repos),
          },
          OTHER_THREAD_ID,
          USER_ID,
        );

      await restore();
      await restore();

      await expect(repos.turns.listByThread(OTHER_THREAD_ID)).resolves.toHaveLength(1);
      await expect(repos.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(false);
    });

    it("serializes concurrent restores into one visibility transition and one delivery", async () => {
      const first = createDrizzleRepositoriesForTest(db);
      const second = createDrizzleRepositoriesForTest(db);
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, OTHER_THREAD_ID));
      const restore = (repos: typeof first) =>
        restoreOwnedThreadFromTrash(
          {
            repos,
            projects,
            workAuthorityResolver,
            obligations: repos.workContextDeliveries,
            workContextDelivery: delivery(repos),
          },
          OTHER_THREAD_ID,
          USER_ID,
        );

      await Promise.all([restore(first), restore(second)]);

      await expect(first.turns.listByThread(OTHER_THREAD_ID)).resolves.toHaveLength(1);
      await expect(first.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(false);
    });

    it("serializes delete after an in-flight restore without losing delete intent", async () => {
      const restoringRepos = createDrizzleRepositoriesForTest(db);
      const deletingRepos = createDrizzleRepositoriesForTest(db);
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, OTHER_THREAD_ID));

      let announceRestoreLock!: () => void;
      let releaseRestore!: () => void;
      const restoreHasLock = new Promise<void>((resolve) => {
        announceRestoreLock = resolve;
      });
      const restoreGate = new Promise<void>((resolve) => {
        releaseRestore = resolve;
      });

      const restoring = restoreOwnedThreadFromTrash(
        {
          repos: restoringRepos,
          projects,
          workAuthorityResolver,
          obligations: {
            async enqueueThread(threadId) {
              const result = await restoringRepos.workContextDeliveries.enqueueThread(threadId);
              announceRestoreLock();
              await restoreGate;
              return result;
            },
          },
          workContextDelivery: delivery(restoringRepos),
        },
        OTHER_THREAD_ID,
        USER_ID,
      );

      await restoreHasLock;
      const deleting = deleteOwnedThreadToTrash(
        {
          repos: deletingRepos,
          projects,
          workAuthorityResolver,
          obligations: deletingRepos.workContextDeliveries,
          workContextDelivery: delivery(deletingRepos),
        },
        OTHER_THREAD_ID,
        USER_ID,
      );

      try {
        await waitForLock("transactionid");
      } finally {
        releaseRestore();
      }

      await expect(restoring).resolves.toMatchObject({ deletedAt: null });
      await expect(deleting).resolves.toMatchObject({ deletedAt: expect.any(String) });
      await expect(
        deletingRepos.threads.lockByIdIncludingDeleted(OTHER_THREAD_ID),
      ).resolves.toMatchObject({ deletedAt: expect.any(String) });
    });

    it("applies sequential delete and restore desired states idempotently", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      const deps = {
        repos,
        projects,
        workAuthorityResolver,
        obligations: repos.workContextDeliveries,
        workContextDelivery: delivery(repos),
      };

      await deleteOwnedThreadToTrash(deps, OTHER_THREAD_ID, USER_ID);
      await restoreOwnedThreadFromTrash(deps, OTHER_THREAD_ID, USER_ID);
      await deleteOwnedThreadToTrash(deps, OTHER_THREAD_ID, USER_ID);
      await deleteOwnedThreadToTrash(deps, OTHER_THREAD_ID, USER_ID);

      await expect(repos.threads.lockByIdIncludingDeleted(OTHER_THREAD_ID)).resolves.toMatchObject({
        deletedAt: expect.any(String),
      });
    });

    it("restores an exact available archived primary from deleted-thread history", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      await db.insert(schema.works).values({
        id: HISTORICAL_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Historical",
        slug: "historical",
        status: "archived",
        archivedAt: new Date(),
      });
      await repos.threadWorks.addMembership(OTHER_THREAD_ID, HISTORICAL_WORK_ID, true);
      await deleteOwnedThreadToTrash(
        {
          repos,
          projects,
          workAuthorityResolver,
          obligations: repos.workContextDeliveries,
          workContextDelivery: delivery(repos),
        },
        OTHER_THREAD_ID,
        USER_ID,
      );
      await restoreOwnedThreadFromTrash(
        {
          repos,
          projects,
          workAuthorityResolver,
          obligations: repos.workContextDeliveries,
          workContextDelivery: delivery(repos),
        },
        OTHER_THREAD_ID,
        USER_ID,
      );
      await expect(repos.threadWorks.findPrimary(OTHER_THREAD_ID)).resolves.toEqual({
        workId: HISTORICAL_WORK_ID,
      });
    });

    it("demotes only a deleted historical primary and never substitutes a reclaimed slug", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      await db.insert(schema.works).values({
        id: HISTORICAL_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Historical",
        slug: "historical",
      });
      await repos.threadWorks.addMembership(OTHER_THREAD_ID, HISTORICAL_WORK_ID, true);
      await deleteOwnedThreadToTrash(
        {
          repos,
          projects,
          workAuthorityResolver,
          obligations: repos.workContextDeliveries,
          workContextDelivery: delivery(repos),
        },
        OTHER_THREAD_ID,
        USER_ID,
      );
      await db
        .update(schema.works)
        .set({ deletedAt: new Date() })
        .where(eq(schema.works.id, HISTORICAL_WORK_ID));
      await db.insert(schema.works).values({
        id: RECLAIMED_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Replacement",
        slug: "historical",
      });
      await restoreOwnedThreadFromTrash(
        {
          repos,
          projects,
          workAuthorityResolver,
          obligations: repos.workContextDeliveries,
          workContextDelivery: delivery(repos),
        },
        OTHER_THREAD_ID,
        USER_ID,
      );
      await expect(repos.threadWorks.findPrimary(OTHER_THREAD_ID)).resolves.toBeNull();
      await expect(repos.threadWorks.listByThread(OTHER_THREAD_ID)).resolves.toContainEqual({
        workId: HISTORICAL_WORK_ID,
        isPrimary: false,
      });
    });

    it("restores to no-Work when Work deletion wins the lifecycle lock", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      const works = createDrizzleProjectWorkRepository({
        db,
        hasUnreviewedDraft: async () => false,
        projectionMutation: createTestWorkProjectionMutation(db),
      });
      await db.insert(schema.works).values({
        id: HISTORICAL_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Deletion winner",
        slug: "deletion-winner",
      });
      await repos.threadWorks.addMembership(OTHER_THREAD_ID, HISTORICAL_WORK_ID, true);
      const deps = {
        repos,
        projects,
        workAuthorityResolver,
        obligations: repos.workContextDeliveries,
        workContextDelivery: delivery(repos),
      };
      await deleteOwnedThreadToTrash(deps, OTHER_THREAD_ID, USER_ID);
      const advisoryKey = 871901;
      await control.unsafe(`
        CREATE FUNCTION test_block_winning_work_delete() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${advisoryKey});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_winning_work_delete
        BEFORE UPDATE ON works
        FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
        EXECUTE FUNCTION test_block_winning_work_delete();
      `);
      await control`SELECT pg_advisory_lock(${advisoryKey})`;
      let advisoryLockHeld = true;
      try {
        const deletion = works.softDelete(HISTORICAL_WORK_ID);
        await waitForLock("advisory");
        const restore = restoreOwnedThreadFromTrash(deps, OTHER_THREAD_ID, USER_ID);
        await waitForLock("transactionid");
        await control`SELECT pg_advisory_unlock(${advisoryKey})`;
        advisoryLockHeld = false;
        await deletion;
        await restore;
        await expect(repos.threadWorks.findPrimary(OTHER_THREAD_ID)).resolves.toBeNull();
        await expect(repos.threadWorks.listByThread(OTHER_THREAD_ID)).resolves.toContainEqual({
          workId: HISTORICAL_WORK_ID,
          isPrimary: false,
        });
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${advisoryKey})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_winning_work_delete ON works;
          DROP FUNCTION IF EXISTS test_block_winning_work_delete();
        `);
      }
    });

    it("blocks Work deletion when thread restore wins the lifecycle lock", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      const works = createDrizzleProjectWorkRepository({
        db,
        hasUnreviewedDraft: async () => false,
        projectionMutation: createTestWorkProjectionMutation(db),
      });
      await db.insert(schema.works).values({
        id: HISTORICAL_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Restore winner",
        slug: "restore-winner",
      });
      await repos.threadWorks.addMembership(OTHER_THREAD_ID, HISTORICAL_WORK_ID, true);
      const deps = {
        repos,
        projects,
        workAuthorityResolver,
        obligations: repos.workContextDeliveries,
        workContextDelivery: delivery(repos),
      };
      await deleteOwnedThreadToTrash(deps, OTHER_THREAD_ID, USER_ID);
      const advisoryKey = 871902;
      await control.unsafe(`
        CREATE FUNCTION test_block_winning_thread_restore() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${advisoryKey});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_winning_thread_restore
        BEFORE UPDATE ON threads
        FOR EACH ROW WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
        EXECUTE FUNCTION test_block_winning_thread_restore();
      `);
      await control`SELECT pg_advisory_lock(${advisoryKey})`;
      let advisoryLockHeld = true;
      try {
        const restore = restoreOwnedThreadFromTrash(deps, OTHER_THREAD_ID, USER_ID);
        await waitForLock("advisory");
        const deletion = works.softDelete(HISTORICAL_WORK_ID).then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        await waitForLock("transactionid");
        await control`SELECT pg_advisory_unlock(${advisoryKey})`;
        advisoryLockHeld = false;
        await restore;
        const outcome = await deletion;
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") {
          expect(outcome.reason).toBeInstanceOf(WorkDeleteBlockedError);
        }
        await expect(repos.threadWorks.findPrimary(OTHER_THREAD_ID)).resolves.toEqual({
          workId: HISTORICAL_WORK_ID,
        });
      } finally {
        if (advisoryLockHeld) await control`SELECT pg_advisory_unlock(${advisoryKey})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_winning_thread_restore ON threads;
          DROP FUNCTION IF EXISTS test_block_winning_thread_restore();
        `);
      }
    });

    it("conceals a deleted thread from non-owners without changing lifecycle state", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, OTHER_THREAD_ID));

      await expect(
        restoreOwnedThreadFromTrash(
          {
            repos,
            projects,
            workAuthorityResolver,
            obligations: repos.workContextDeliveries,
            workContextDelivery: delivery(repos),
          },
          OTHER_THREAD_ID,
          OTHER_USER_ID,
        ),
      ).rejects.toThrow("Thread not found");

      await expect(
        restoreOwnedThreadFromTrash(
          {
            repos,
            projects,
            workAuthorityResolver,
            obligations: repos.workContextDeliveries,
            workContextDelivery: delivery(repos),
          },
          "00000000-0000-4000-8000-000000000799",
          OTHER_USER_ID,
        ),
      ).rejects.toThrow("Thread not found");

      await expect(repos.threads.lockByIdIncludingDeleted(OTHER_THREAD_ID)).resolves.toMatchObject({
        deletedAt: expect.any(String),
      });
      await expect(repos.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(false);
    });

    it("rolls deletion and obligation state back when restore enqueue fails", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, OTHER_THREAD_ID));

      await expect(
        restoreOwnedThreadFromTrash(
          {
            repos,
            projects,
            workAuthorityResolver,
            obligations: {
              async enqueueThread(threadId) {
                await repos.workContextDeliveries.enqueueThread(threadId);
                throw new Error("injected restore enqueue failure");
              },
            },
            workContextDelivery: delivery(repos),
          },
          OTHER_THREAD_ID,
          USER_ID,
        ),
      ).rejects.toThrow("injected restore enqueue failure");

      await expect(repos.threads.lockByIdIncludingDeleted(OTHER_THREAD_ID)).resolves.toMatchObject({
        deletedAt: expect.any(String),
      });
      await expect(repos.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(false);
      await expect(repos.turns.listByThread(OTHER_THREAD_ID)).resolves.toHaveLength(0);
    });

    it("parks an archived obligation, resumes after unarchive, and cascades on hard deletion", async () => {
      const repos = createDrizzleRepositoriesForTest(db);
      await repos.workContextDeliveries.enqueueThread(THREAD_ID);
      await repos.threads.updateStatus(THREAD_ID, "archived");

      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
      await expect(repos.workContextDeliveries.listPendingThreadIds()).resolves.toEqual([]);
      await expect(delivery(repos).sweep()).resolves.toBeUndefined();
      await expect(repos.turns.listByThread(THREAD_ID)).resolves.toHaveLength(0);

      await repos.threads.updateStatus(THREAD_ID, "idle");
      await delivery(repos).sweep();
      await expect(repos.turns.listByThread(THREAD_ID)).resolves.toHaveLength(1);
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);

      await repos.workContextDeliveries.enqueueThread(OTHER_THREAD_ID);
      await db.delete(schema.threads).where(eq(schema.threads.id, OTHER_THREAD_ID));
      await expect(repos.workContextDeliveries.isPending(OTHER_THREAD_ID)).resolves.toBe(false);
    });
  });
}
