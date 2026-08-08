/** PostgreSQL coverage for the writer Work-rebind HTTP boundary. */

import { createApp, toWebHandler } from "nitro/h3";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../domains/threads/test-support/thread-work-postgres-harness.js";

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
    const { createDrizzleProjectPreferencesRepository } = await import(
      "../domains/preferences/index.js"
    );
    const { handleRebindThreadWorkRequest } = await import("./thread-work-rebind-route.js");
    const { default: interruptErrorHandler } = await import("./interrupt-error-handler.js");
    const { rebindThreadWork } = await import("../domains/threads/domain/rebind-thread-work.js");
    const { createDrizzleThreadRunOwnership } = await import(
      "../domains/runtime/adapters/drizzle-thread-run-ownership.js"
    );
    const { createDrizzleRepositories } = await import(
      "../domains/threads/adapters/drizzle/repositories.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const threads = createDrizzleRepositories(db);
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
    });

    beforeEach(() => resetThreadWorkRaceFixture(db));

    afterAll(async () => {
      await db.close();
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
          rebindThreadWork(
            {
              threads: threads.threads,
              threadWorks: threads.threadWorks,
              works,
              preferences,
              obligations: threads.workContextDeliveries,
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

    it("serializes a target deleted after preflight as a refreshable lifecycle conflict", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const preferences = createDrizzleProjectPreferencesRepository({ db });
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
            preferences,
            obligations: threads.workContextDeliveries,
            workContextDelivery: { deliverAfterCommit: async () => "delivered" as const },
            transaction: threads.transaction,
            runOwnership: {
              tryAcquire: async () => ({ release: async () => {} }),
            },
          },
          { threadId: THREAD_ID, userId: USER_ID, body: { workId: TARGET_WORK_ID } },
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
          message: "That Work is no longer available. Refresh Works and choose another.",
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
      const preferences = createDrizzleProjectPreferencesRepository({ db });
      const projects = createDrizzleProjectRepository({ db });
      const failingDb = createDb(DATABASE_URL, {
        max: 1,
        postgres: { connection: { statement_timeout: 50 } },
      });
      const failingThreads = createDrizzleRepositories(failingDb);
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
        await sql`SELECT id FROM works WHERE id = ${WORK_ID} FOR UPDATE`;
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
              preferences,
              obligations: threads.workContextDeliveries,
              workContextDelivery: { deliverAfterCommit: async () => "delivered" as const },
              transaction: async (operation) => operation(),
              runOwnership: {
                tryAcquire: async () => ({ release: async () => {} }),
              },
            },
            { threadId: THREAD_ID, userId: USER_ID, body: { workId: TARGET_WORK_ID } },
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
  });
}
