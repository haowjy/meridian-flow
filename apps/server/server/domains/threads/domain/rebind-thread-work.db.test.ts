/** PostgreSQL coverage for nullable and concurrent thread Work rebinds. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../test-support/thread-work-postgres-harness.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("nullable thread Work rebind (postgres)", () => {});
else
  describe("nullable thread Work rebind (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { eq } = await import("drizzle-orm");
    const { createDrizzleProjectWorkRepository } = await import("../../projects/index.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../adapters/drizzle/repositories.js"
    );
    const { rebindThreadWork } = await import("./rebind-thread-work.js");
    const db = createDb(DATABASE_URL, { max: 4 });
    const repos = createDrizzleRepositoriesForTest(db);
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
      projectionMutation: createTestWorkProjectionMutation(db),
    });
    const ids = THREAD_WORK_RACE;
    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
      await db
        .update(schema.works)
        .set({ status: "active", archivedAt: null })
        .where(eq(schema.works.id, ids.targetWorkId));
    });
    afterAll(() => db.close());
    const rebind = (target: { kind: "none" } | { kind: "work"; workId: string }) =>
      repos.transaction(() =>
        rebindThreadWork(
          {
            threads: repos.threads,
            threadWorks: repos.threadWorks,
            works,
            obligations: repos.workContextDeliveries,
          },
          { threadId: ids.threadId, target } as never,
        ),
      );

    it("supports none to Work to none while retaining historical membership", async () => {
      await expect(rebind({ kind: "none" })).resolves.toMatchObject({
        before: { kind: "none" },
        after: { kind: "none" },
        changed: false,
      });
      await expect(rebind({ kind: "work", workId: ids.workId })).resolves.toMatchObject({
        before: { kind: "none" },
        after: { kind: "work", workId: ids.workId },
        changed: true,
      });
      await expect(rebind({ kind: "none" })).resolves.toMatchObject({
        before: { kind: "work", workId: ids.workId },
        after: { kind: "none" },
        changed: true,
      });
      await expect(repos.threadWorks.findPrimary(ids.threadId)).resolves.toBeNull();
      await expect(repos.threadWorks.listByThread(ids.threadId)).resolves.toContainEqual({
        workId: ids.workId,
        isPrimary: false,
      });
    });

    it("persists derived and subagent no-Work scope without membership rows", async () => {
      const derived = await repos.threads.createDerivedPrimary({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: null,
        parentThreadId: ids.threadId,
        originType: "handoff",
        currentAgent: null,
      } as never);
      const subagent = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: null,
        parentThreadId: ids.threadId,
        rootThreadId: ids.threadId,
        spawnDepth: 1,
        currentAgent: "writer",
        composedSystemPrompt: "frozen prompt",
        bakedSkillSlugs: [],
      } as never);
      expect(derived.workId).toBeNull();
      expect(subagent.workId).toBeNull();
      await expect(repos.threadWorks.findPrimary(derived.id)).resolves.toBeNull();
      await expect(repos.threadWorks.findPrimary(subagent.id)).resolves.toBeNull();
    });

    it("serializes concurrent Work targets to one primary", async () => {
      await Promise.all([
        rebind({ kind: "none" }),
        rebind({ kind: "work", workId: ids.targetWorkId }),
      ]);
      const primary = await repos.threadWorks.findPrimary(ids.threadId);
      expect(primary === null || primary.workId === ids.targetWorkId).toBe(true);
      expect(
        (await repos.threadWorks.listByThread(ids.threadId)).filter((row) => row.isPrimary),
      ).toHaveLength(primary ? 1 : 0);
    });

    it("retains historical feed projection and rolls back if obligation enqueue fails", async () => {
      await repos.threadWorks.addMembership(ids.threadId, ids.workId, true);
      await expect(
        repos.transaction(() =>
          rebindThreadWork(
            {
              threads: repos.threads,
              threadWorks: repos.threadWorks,
              works,
              obligations: {
                enqueueThread: async () => {
                  throw new Error("injected durable enqueue failure");
                },
              },
            },
            {
              threadId: ids.threadId,
              target: { kind: "work", workId: ids.targetWorkId },
            } as never,
          ),
        ),
      ).rejects.toThrow("injected durable enqueue failure");
      await expect(repos.threadWorks.findPrimary(ids.threadId)).resolves.toEqual({
        workId: ids.workId,
      });

      await rebind({ kind: "work", workId: ids.targetWorkId });
      for (const workId of [ids.workId, ids.targetWorkId]) {
        const feed = await repos.workChatFeed.queryPage({
          projectId: ids.projectId,
          workId,
          userId: ids.userId,
          after: null,
          limit: 2,
        });
        expect(feed).toHaveLength(1);
        expect(feed[0]?.item).toMatchObject({
          id: ids.threadId,
          work: { id: ids.targetWorkId, title: "Rebound target" },
        });
      }
    });

    it("translates target deletion after preflight into the canonical error", async () => {
      const staleTarget = await works.findById(ids.targetWorkId);
      if (!staleTarget) throw new Error("Expected target fixture");
      let targetReads = 0;
      const racingWorks = {
        async findById(workId: string) {
          if (workId !== ids.targetWorkId) return works.findById(workId);
          targetReads += 1;
          if (targetReads === 1) await works.softDelete(ids.targetWorkId);
          return staleTarget;
        },
      };
      await expect(
        repos.transaction(() =>
          rebindThreadWork(
            {
              threads: repos.threads,
              threadWorks: repos.threadWorks,
              works: racingWorks,
              obligations: repos.workContextDeliveries,
            },
            {
              threadId: ids.threadId,
              target: { kind: "work", workId: ids.targetWorkId },
            } as never,
          ),
        ),
      ).rejects.toMatchObject({
        name: "RebindThreadWorkError",
        code: "target_work_unavailable",
        workId: ids.targetWorkId,
      });
      await expect(repos.threadWorks.findPrimary(ids.threadId)).resolves.toBeNull();
    });
  });
