/** PostgreSQL coverage: every thread-create path persists an authoritative rootThreadId. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../../test-support/thread-work-postgres-harness.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("thread root persistence (postgres)", () => {});
else
  describe("thread root persistence (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { eq } = await import("drizzle-orm");
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
    const db = createDb(DATABASE_URL, { max: 4 });
    const repos = createDrizzleRepositoriesForTest(db);
    const ids = THREAD_WORK_RACE;

    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
    });
    afterAll(() => db.close());

    async function persistedRoot(threadId: string) {
      const [row] = await db
        .select({ rootThreadId: schema.threads.rootThreadId })
        .from(schema.threads)
        .where(eq(schema.threads.id, threadId));
      return row?.rootThreadId ?? null;
    }

    it("roots an organic primary at itself", async () => {
      const created = await repos.threads.create({
        userId: ids.userId,
        projectId: ids.projectId,
        title: "Organic root",
      });
      expect(await persistedRoot(created.id)).toBe(created.id);
    });

    it("roots a derived primary at itself, not its parent", async () => {
      const derived = await repos.threads.createDerivedPrimary({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        parentThreadId: ids.threadId,
        originType: "handoff",
      });
      expect(derived.parentThreadId).toBe(ids.threadId);
      expect(await persistedRoot(derived.id)).toBe(derived.id);
    });

    it("roots a subagent at the spawning root", async () => {
      const subagent = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        parentThreadId: ids.threadId,
        rootThreadId: ids.threadId,
        spawnDepth: 1,
      });
      expect(await persistedRoot(subagent.id)).toBe(ids.threadId);
    });
  });
