/** PostgreSQL coverage for root-conversation Work bootstrap. */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../domains/threads/test-support/thread-work-postgres-harness.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const {
  userId: USER_ID,
  projectId: PROJECT_ID,
  threadId: THREAD_ID,
  workId: WORK_ID,
  targetWorkId: TARGET_WORK_ID,
  branchId: BRANCH_ID,
} = THREAD_WORK_RACE;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread creation (postgres)", () => {});
} else {
  describe("thread creation (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { eq } = await import("drizzle-orm");
    const { createInMemoryEventSink } = await import("../domains/observability/index.js");
    const { createDrizzleProjectPreferencesRepository } = await import(
      "../domains/preferences/index.js"
    );
    const { createDrizzleProjectRepository, createDrizzleProjectWorkRepository } = await import(
      "../domains/projects/index.js"
    );
    const { createDrizzleRepositories } = await import(
      "../domains/threads/adapters/drizzle/repositories.js"
    );
    const { createThreadForProject } = await import("./thread-creation.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const threads = createDrizzleRepositories(db);
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
    });
    const preferences = createDrizzleProjectPreferencesRepository({ db });

    beforeEach(() => resetThreadWorkRaceFixture(db));
    afterAll(() => db.close());

    it("bootstraps a root conversation when the project has no Work", async () => {
      await db.delete(schema.threads).where(eq(schema.threads.id, THREAD_ID));
      await db.delete(schema.documentBranches).where(eq(schema.documentBranches.id, BRANCH_ID));
      await db.delete(schema.works).where(eq(schema.works.id, WORK_ID));
      await db.delete(schema.works).where(eq(schema.works.id, TARGET_WORK_ID));

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
      await expect(preferences.getNewChatFallbackWorkId(USER_ID, PROJECT_ID)).resolves.toBe(
        thread.workId,
      );
      await expect(threads.threadWorks.findPrimary(thread.id)).resolves.toEqual({
        workId: thread.workId,
      });
    });
  });
}
