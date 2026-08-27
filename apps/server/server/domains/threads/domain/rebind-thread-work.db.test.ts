/** PostgreSQL coverage for the canonical thread Work-rebind transaction. */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../test-support/thread-work-postgres-harness.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const {
  userId: USER_ID,
  projectId: PROJECT_ID,
  threadId: THREAD_ID,
  workId: WORK_ID,
  targetWorkId: TARGET_WORK_ID,
} = THREAD_WORK_RACE;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread Work rebind domain (postgres)", () => {});
} else {
  describe("thread Work rebind domain (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDrizzleProjectWorkRepository, WorkLifecycleUnavailableError } = await import(
      "../../projects/index.js"
    );
    const { createDrizzleProjectPreferencesRepository } = await import(
      "../../preferences/index.js"
    );
    const { createDrizzleRepositories } = await import("../adapters/drizzle/repositories.js");
    const { rebindThreadWork } = await import("./rebind-thread-work.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const threads = createDrizzleRepositories(db);
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
    });
    const preferences = createDrizzleProjectPreferencesRepository({ db });

    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
    });

    afterAll(() => db.close());

    function rebindWith(workRepository: Pick<typeof works, "findById"> = works) {
      return threads.transaction(() =>
        rebindThreadWork(
          {
            threads: threads.threads,
            threadWorks: threads.threadWorks,
            works: workRepository,
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
    }

    it("atomically rebinds to an archived Work, updates preference, and enqueues context", async () => {
      await expect(rebindWith()).resolves.toMatchObject({
        previousWorkId: WORK_ID,
        work: { id: TARGET_WORK_ID, status: "archived" },
        changed: true,
      });
      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: TARGET_WORK_ID,
      });
      await expect(preferences.getCurrentWorkId(USER_ID, PROJECT_ID)).resolves.toBe(TARGET_WORK_ID);
      await expect(threads.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
    });

    it("rolls back binding and preference when durable context enqueue fails", async () => {
      await expect(
        threads.transaction(() =>
          rebindThreadWork(
            {
              threads: threads.threads,
              threadWorks: threads.threadWorks,
              works,
              preferences,
              obligations: {
                enqueueThread: async () => {
                  throw new Error("injected durable enqueue failure");
                },
              },
            },
            {
              threadId: THREAD_ID,
              targetWorkId: TARGET_WORK_ID,
              preferenceUserId: USER_ID,
            },
          ),
        ),
      ).rejects.toThrow("injected durable enqueue failure");
      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: WORK_ID,
      });
      await expect(preferences.getCurrentWorkId(USER_ID, PROJECT_ID)).resolves.toBeNull();
      await expect(threads.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);
    });

    it("preserves exact lifecycle-error identity from the real membership adapter", async () => {
      const staleTarget = await works.findById(TARGET_WORK_ID);
      if (!staleTarget) throw new Error("Expected target fixture");
      let targetReads = 0;
      const targetDeletedAfterPreflight = {
        async findById(workId: string) {
          if (workId !== TARGET_WORK_ID) return works.findById(workId);
          targetReads += 1;
          if (targetReads === 1) await works.softDelete(TARGET_WORK_ID);
          return staleTarget;
        },
      };

      let thrown: unknown;
      try {
        await rebindWith(targetDeletedAfterPreflight);
      } catch (cause) {
        thrown = cause;
      }

      expect(thrown).toBeInstanceOf(WorkLifecycleUnavailableError);
      expect(thrown).toMatchObject({ workId: TARGET_WORK_ID, state: "deleted" });
      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: WORK_ID,
      });
    });
  });
}
