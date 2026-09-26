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

    it("freezes all three bake fields at the database boundary, including an empty skill list", async () => {
      const bakedTools = [{ type: "function", name: "write" }];
      await repos.threads.bakeComposedSystemPrompt(ids.threadId, {
        composedSystemPrompt: "Frozen prompt",
        bakedSkillSlugs: [],
        bakedTools,
      });
      for (const patch of [
        { composedSystemPrompt: "Changed prompt" },
        { composedSystemPrompt: null },
        { bakedSkillSlugs: ["new-skill"] },
        { bakedSkillSlugs: null },
        { bakedTools: [] },
        { bakedTools: null },
      ]) {
        await expect(
          db.update(schema.threads).set(patch).where(eq(schema.threads.id, ids.threadId)),
        ).rejects.toThrow();
      }
      await db
        .update(schema.threads)
        .set({
          title: "Ordinary updates still work",
          composedSystemPrompt: "Frozen prompt",
          bakedSkillSlugs: [],
          bakedTools,
        })
        .where(eq(schema.threads.id, ids.threadId));
      const frozen = await repos.threads.bakeComposedSystemPrompt(ids.threadId, {
        composedSystemPrompt: "Losing CAS",
        bakedSkillSlugs: ["ignored"],
        bakedTools: [{ type: "function", name: "ignored" }],
      });
      expect(frozen.composedSystemPrompt).toBe("Frozen prompt");
      expect(frozen.bakedSkillSlugs).toEqual([]);
      expect(frozen.bakedTools).toEqual(bakedTools);
    });

    it("roots an organic primary at itself", async () => {
      const created = await repos.threads.create({
        userId: ids.userId,
        projectId: ids.projectId,
        title: "Organic root",
      });
      expect(await persistedRoot(created.id)).toBe(created.id);
    });

    it("a fork/handoff of an organic root shares that root and has no parent", async () => {
      // The source (`ids.threadId`) is itself a root: null parent, self root.
      const derived = await repos.threads.createDerivedPrimary({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        source: { parentThreadId: null, rootThreadId: ids.threadId, spawnDepth: 0 },
        originType: "handoff",
      });
      expect(derived.parentThreadId).toBeNull();
      expect(await persistedRoot(derived.id)).toBe(ids.threadId);
    });

    it("a fork of a subagent becomes its sibling: same parent and root, same depth", async () => {
      const subagent = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        parentThreadId: ids.threadId,
        rootThreadId: ids.threadId,
        spawnDepth: 2,
      });
      const fork = await repos.threads.createDerivedPrimary({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        source: subagent,
        originType: "fork",
        originTurnId: crypto.randomUUID(),
      });
      expect(fork.parentThreadId).toBe(subagent.parentThreadId);
      expect(fork.spawnDepth).toBe(subagent.spawnDepth);
      expect(await persistedRoot(fork.id)).toBe(ids.threadId);
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
