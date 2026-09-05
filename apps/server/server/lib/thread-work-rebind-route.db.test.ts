/** PostgreSQL coverage for the writer Work-rebind HTTP boundary. */

import { createApp, toWebHandler } from "nitro/h3";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../domains/threads/test-support/thread-work-postgres-harness.js";
import { createTestWorkProjectionMutation } from "../test-support/work-projection.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const {
  userId: USER_ID,
  threadId: THREAD_ID,
  workId: WORK_ID,
  targetWorkId: TARGET_WORK_ID,
} = THREAD_WORK_RACE;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread Work rebind route (postgres)", () => {});
} else {
  describe("thread Work rebind route (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDrizzleProjectRepository, createDrizzleProjectWorkRepository } = await import(
      "../domains/projects/index.js"
    );
    const { createDrizzleNoticePort } = await import("../domains/notices/index.js");
    const { handleRebindThreadWorkRequest } = await import("./thread-work-rebind-route.js");
    const { default: interruptErrorHandler } = await import("./interrupt-error-handler.js");
    const { createDrizzleThreadRunOwnership } = await import(
      "../domains/runtime/adapters/drizzle-thread-run-ownership.js"
    );
    const { createDrizzleRepositoriesForTest } = await import(
      "../domains/threads/adapters/drizzle/repositories.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const threads = createDrizzleRepositoriesForTest(db);
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
      projectionMutation: createTestWorkProjectionMutation(db),
    });
    const notices = createDrizzleNoticePort(db);

    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
      await works.unarchive(TARGET_WORK_ID);
    });

    afterAll(async () => {
      await db.close();
    });

    it("excludes a writer rebind while another server instance owns the run", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const projects = createDrizzleProjectRepository({ db });
      const modelInstance = createDrizzleThreadRunOwnership(db);
      const writerInstance = createDrizzleThreadRunOwnership(db);
      const modelClaim = await modelInstance.tryAcquire(THREAD_ID);
      expect(modelClaim).not.toBeNull();

      try {
        let thrown: unknown;
        try {
          await handleRebindThreadWorkRequest(
            {
              threads: threads.threads,
              threadWorks: threads.threadWorks,
              projects,
              works,
              obligations: threads.workContextDeliveries,
              workContextDelivery: { deliverAfterCommit: async () => "delivered" as const },
              notices,
              transaction: threads.transaction,
              runOwnership: writerInstance,
            },
            {
              threadId: THREAD_ID,
              userId: USER_ID,
              body: { target: { kind: "work", workId: TARGET_WORK_ID } },
            },
          );
        } catch (cause) {
          thrown = cause;
        }
        const response = interruptErrorHandler(thrown, {});
        expect(response?.status).toBe(409);
        await expect(response?.json()).resolves.toMatchObject({
          error: { code: "thread_busy" },
        });
        await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
          workId: WORK_ID,
        });
      } finally {
        await modelClaim?.release();
      }
      await handleRebindThreadWorkRequest(
        {
          threads: threads.threads,
          threadWorks: threads.threadWorks,
          projects,
          works,
          obligations: threads.workContextDeliveries,
          workContextDelivery: { deliverAfterCommit: async () => "delivered" as const },
          notices,
          transaction: threads.transaction,
          runOwnership: writerInstance,
        },
        {
          threadId: THREAD_ID,
          userId: USER_ID,
          body: { target: { kind: "work", workId: TARGET_WORK_ID } },
        },
      );

      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: TARGET_WORK_ID,
      });
    });

    it("serializes a target deleted after preflight as a refreshable lifecycle conflict", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const projects = createDrizzleProjectRepository({ db });
      const staleTarget = await works.findById(TARGET_WORK_ID);
      if (!staleTarget) throw new Error("Expected target fixture");
      let targetReads = 0;
      const stalePreflightWorks = {
        async findById(workId: string) {
          if (workId !== TARGET_WORK_ID) return works.findById(workId);
          targetReads += 1;
          if (targetReads === 1) await works.softDelete(TARGET_WORK_ID);
          return staleTarget;
        },
      };

      let thrown: unknown;
      try {
        await handleRebindThreadWorkRequest(
          {
            threads: threads.threads,
            threadWorks: threads.threadWorks,
            projects,
            works: stalePreflightWorks,
            obligations: threads.workContextDeliveries,
            workContextDelivery: { deliverAfterCommit: async () => "delivered" as const },
            notices,
            transaction: threads.transaction,
            runOwnership: {
              tryAcquire: async () => ({ release: async () => {} }),
            },
          },
          {
            threadId: THREAD_ID,
            userId: USER_ID,
            body: { target: { kind: "work", workId: TARGET_WORK_ID } },
          },
        );
      } catch (cause) {
        thrown = cause;
      }

      const response = interruptErrorHandler(thrown, {});
      expect(response?.status).toBe(409);
      await expect(response?.json()).resolves.toEqual({
        kind: "error",
        error: {
          code: "work_unavailable",
          message: "That Work is no longer available. Refresh Work and choose another.",
          retryable: false,
          source: "system",
          details: { refresh: "works" },
        },
      });
      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: WORK_ID,
      });
    });

    it("returns 5xx when the real lifecycle lock query is cancelled", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const projects = createDrizzleProjectRepository({ db });
      const failingDb = createDb(DATABASE_URL, {
        max: 1,
        postgres: { connection: { statement_timeout: 50 } },
      });
      const failingThreads = createDrizzleRepositoriesForTest(failingDb);
      const blocker = postgres(DATABASE_URL, { max: 1 });
      let unlock!: () => void;
      const keepLocked = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      let locked!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holdLock = blocker.begin(async (sql) => {
        await sql`SELECT id FROM works WHERE id = ${TARGET_WORK_ID} FOR UPDATE`;
        locked();
        await keepLocked;
      });
      await lockAcquired;

      try {
        const app = createApp();
        app.use(async () =>
          handleRebindThreadWorkRequest(
            {
              threads: threads.threads,
              threadWorks: failingThreads.threadWorks,
              projects,
              works,
              obligations: threads.workContextDeliveries,
              workContextDelivery: { deliverAfterCommit: async () => "delivered" as const },
              notices,
              transaction: async (operation) => operation(),
              runOwnership: {
                tryAcquire: async () => ({ release: async () => {} }),
              },
            },
            {
              threadId: THREAD_ID,
              userId: USER_ID,
              body: { target: { kind: "work", workId: TARGET_WORK_ID } },
            },
          ),
        );

        const response = await toWebHandler(app)(new Request("https://server.local/thread-work"));
        expect(response.status).toBe(500);
        const body = await response.text();
        expect(body).not.toContain("not_found");
        expect(body).not.toContain("work_unavailable");
      } finally {
        unlock();
        await holdLock;
        await blocker.end();
        await failingDb.close();
      }
    });

    it("commits the writer binding and one durable Notice in the same transaction", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const projects = createDrizzleProjectRepository({ db });

      await handleRebindThreadWorkRequest(
        {
          threads: threads.threads,
          threadWorks: threads.threadWorks,
          projects,
          works,
          obligations: threads.workContextDeliveries,
          workContextDelivery: { deliverAfterCommit: async () => "pending" as const },
          notices,
          transaction: threads.transaction,
          runOwnership: {
            tryAcquire: async () => ({ release: async () => {} }),
          },
        },
        {
          threadId: THREAD_ID,
          userId: USER_ID,
          body: { target: { kind: "work", workId: TARGET_WORK_ID } },
        },
      );

      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: TARGET_WORK_ID,
      });
      await expect(threads.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);

      const recreatedPort = createDrizzleNoticePort(db);
      await expect(recreatedPort.drainForModelContext(THREAD_ID)).resolves.toMatchObject([
        {
          kind: "work_switched",
          scope: { kind: "thread", threadId: THREAD_ID },
          data: {
            previousWorkId: WORK_ID,
            previousWorkName: "Race target",
            workId: TARGET_WORK_ID,
            workName: "Rebound target",
            actor: "writer",
          },
        },
      ]);
      await expect(recreatedPort.drainForModelContext(THREAD_ID)).resolves.toEqual([]);
    });

    it("rolls back binding, context obligation, and Notice on Notice failure", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const projects = createDrizzleProjectRepository({ db });

      await expect(
        handleRebindThreadWorkRequest(
          {
            threads: threads.threads,
            threadWorks: threads.threadWorks,
            projects,
            works,
            obligations: threads.workContextDeliveries,
            workContextDelivery: { deliverAfterCommit: async () => "delivered" as const },
            notices: {
              record: async () => {
                throw new Error("injected Notice failure");
              },
            },
            transaction: threads.transaction,
            runOwnership: {
              tryAcquire: async () => ({ release: async () => {} }),
            },
          },
          {
            threadId: THREAD_ID,
            userId: USER_ID,
            body: { target: { kind: "work", workId: TARGET_WORK_ID } },
          },
        ),
      ).rejects.toThrow("injected Notice failure");

      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: WORK_ID,
      });
      await expect(threads.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);
      await expect(notices.drainForModelContext(THREAD_ID)).resolves.toEqual([]);
    });
  });
}
