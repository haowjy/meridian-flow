/** PostgreSQL coverage for No Work and concurrent thread Work rebinds. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../test-support/thread-work-postgres-harness.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("thread Work rebind (postgres)", () => {});
else
  describe("thread Work rebind (postgres)", async () => {
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
    const rebind = (workId: string) =>
      repos.transaction(() =>
        rebindThreadWork(
          {
            threads: repos.threads,
            threadWorks: repos.threadWorks,
            works,
            obligations: repos.workContextDeliveries,
          },
          { threadId: ids.threadId, workId },
        ),
      );

    it("allows leaving archived Work but rejects acquiring it again", async () => {
      await rebind(ids.workId);
      await db
        .update(schema.works)
        .set({ status: "archived", archivedAt: new Date() })
        .where(eq(schema.works.id, ids.workId));
      await expect(rebind(ids.noWorkId)).resolves.toMatchObject({
        after: { workId: ids.noWorkId, name: "No Work", slug: null },
        changed: true,
      });
      await expect(rebind(ids.workId)).rejects.toMatchObject({
        code: "target_work_unavailable",
      });
      await expect(repos.threadWorks.findPrimary(ids.threadId)).resolves.toEqual({
        workId: ids.noWorkId,
      });
    });

    it("supports No Work to named Work to No Work while retaining historical membership", async () => {
      await expect(rebind(ids.noWorkId)).resolves.toMatchObject({
        before: { workId: ids.noWorkId, name: "No Work", slug: null },
        after: { workId: ids.noWorkId, name: "No Work", slug: null },
        changed: true,
      });
      await expect(rebind(ids.workId)).resolves.toMatchObject({
        before: { workId: ids.noWorkId, name: "No Work", slug: null },
        after: { workId: ids.workId },
        changed: true,
      });
      await expect(rebind(ids.noWorkId)).resolves.toMatchObject({
        before: { workId: ids.workId },
        after: { workId: ids.noWorkId, name: "No Work", slug: null },
        changed: true,
      });
      await expect(repos.threadWorks.findPrimary(ids.threadId)).resolves.toEqual({
        workId: ids.noWorkId,
      });
      await expect(repos.threadWorks.listByThread(ids.threadId)).resolves.toContainEqual({
        workId: ids.workId,
        isPrimary: false,
      });
      await expect(repos.threadWorks.listByThread(ids.threadId)).resolves.toContainEqual({
        workId: ids.noWorkId,
        isPrimary: true,
      });
    });

    it("derived and subagent inherit No Work membership", async () => {
      await repos.threadWorks.addMembership(ids.threadId, ids.noWorkId, true);
      const derived = await repos.threads.createDerivedPrimary({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        parentThreadId: ids.threadId,
        originType: "handoff",
      } as never);
      const subagent = await repos.threads.createSubagent({
        userId: ids.userId,
        projectId: ids.projectId,
        workId: ids.noWorkId,
        parentThreadId: ids.threadId,
        rootThreadId: ids.threadId,
        spawnDepth: 1,
      } as never);
      await repos.threadWorks.addMembership(derived.id, ids.noWorkId, true);
      await repos.threadWorks.addMembership(subagent.id, ids.noWorkId, true);
      expect(subagent.composedSystemPrompt).toBeNull();
      expect(subagent.bakedSkillSlugs).toBeNull();
      const [stored] = await db
        .select({ hash: schema.threads.systemPromptHash })
        .from(schema.threads)
        .where(eq(schema.threads.id, subagent.id));
      expect(stored.hash).toBeNull();
      await expect(repos.threadWorks.findPrimary(derived.id)).resolves.toEqual({
        workId: ids.noWorkId,
      });
      await expect(repos.threadWorks.findPrimary(subagent.id)).resolves.toEqual({
        workId: ids.noWorkId,
      });
    });

    it("rolls back child, retained binding, and inherited Work in one transaction", async () => {
      const { createDrizzleAgentRevisionStore } = await import("../../packages/index.js");
      const revisions = createDrizzleAgentRevisionStore(db);
      const installed = await revisions.installSource({
        coordinate: "fixture/child-atomicity",
        files: {
          "agents/worker.md": "---\nmodel: fixture-model\n---\nWorker",
        },
      });
      let childId = "";
      await expect(
        repos.transaction(async () => {
          const child = await repos.threads.createSubagent({
            userId: ids.userId,
            projectId: ids.projectId,
            parentThreadId: ids.threadId,
            rootThreadId: ids.threadId,
            spawnDepth: 1,
          });
          childId = child.id;
          await revisions.bindThread(
            child.id,
            installed.definitions[0].id,
            bindingConfiguration,
            null,
          );
          await repos.threadWorks.addMembership(child.id, ids.targetWorkId, true);
          throw new Error("after Work membership");
        }),
      ).rejects.toThrow("after Work membership");
      expect(await repos.threads.findById(childId)).toBeNull();
      expect(await revisions.readThreadBinding(childId)).toBeUndefined();
      expect(await repos.threadWorks.findPrimary(childId)).toBeNull();
    });

    it("serializes concurrent Work targets to one primary", async () => {
      await Promise.all([rebind(ids.noWorkId), rebind(ids.targetWorkId)]);
      const primary = await repos.threadWorks.findPrimary(ids.threadId);
      expect(primary?.workId === ids.noWorkId || primary?.workId === ids.targetWorkId).toBe(true);
      expect(
        (await repos.threadWorks.listByThread(ids.threadId)).filter((row) => row.isPrimary),
      ).toHaveLength(1);
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
              workId: ids.targetWorkId,
            },
          ),
        ),
      ).rejects.toThrow("injected durable enqueue failure");
      await expect(repos.threadWorks.findPrimary(ids.threadId)).resolves.toEqual({
        workId: ids.workId,
      });

      await rebind(ids.targetWorkId);
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
        findNoWork: (projectId: typeof ids.projectId) => works.findNoWork(projectId),
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
              workId: ids.targetWorkId,
            },
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

const bindingConfiguration = {
  model: "mock-model",
  skills: { load: [], available: [] },
  namedTargets: [],
};
