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
    let originTurnId = "";

    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
      originTurnId = (
        await repos.turns.create({
          threadId: ids.threadId,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        })
      ).id;
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

    it("persists a derived primary with the source's sibling lineage", async () => {
      const subagent = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        parentThreadId: ids.threadId,
        rootThreadId: ids.threadId,
        originTurnId: originTurnId as never,
        spawnDepth: 2,
      });
      const sourceTurn = await repos.turns.create({
        threadId: subagent.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      const { thread: fork } = await repos.threads.createDerivedPrimary({
        id: crypto.randomUUID() as never,
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        source: subagent,
        originType: "fork",
        originTurnId: sourceTurn.id,
      });
      expect(fork.parentThreadId).toBe(subagent.parentThreadId);
      expect(fork.spawnDepth).toBe(subagent.spawnDepth);
      expect(await persistedRoot(fork.id)).toBe(ids.threadId);
    });
  });
