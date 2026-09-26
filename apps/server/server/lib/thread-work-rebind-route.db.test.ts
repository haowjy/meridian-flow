import { createTestDrizzleDelivery } from "../domains/runtime/loop/__tests__/test-drizzle-delivery.js";

/** PostgreSQL coverage for the writer Work-rebind HTTP boundary. */

import { setTimeout as delay } from "node:timers/promises";
import { createApp, toWebHandler } from "nitro/h3";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createProjectRepositoryForTest } from "../domains/projects/test-support/project-repository.js";
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
    const { createDrizzleProjectWorkRepository } = await import("../domains/projects/index.js");
    const createDrizzleProjectRepository = createProjectRepositoryForTest;
    const { createDrizzleNoticePort } = await import("../domains/notices/index.js");
    const { handleRebindThreadWorkRequest } = await import("./thread-work-rebind-route.js");
    const { default: interruptErrorHandler } = await import("./interrupt-error-handler.js");
    const { createDrizzleRunClaim } = await import(
      "../domains/runtime/adapters/drizzle-run-claim.js"
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

    it.each([
      "writer",
      "rebind",
    ] as const)("commits concurrent writer enqueue and Work rebind with %s first", async (first) => {
      const { createDrizzleEventJournalWriter, createDrizzleEventJournalReader } = await import(
        "../domains/threads/index.js"
      );
      const { persistWriterEnqueue } = await import("../domains/runtime/loop/writer-enqueue.js");
      const { createWorkContextReader } = await import("../domains/runtime/loop/work-context.js");
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const untouchedAt = new Date("2000-01-01T00:00:00.000Z");
      const schema = await import("@meridian/database/schema");
      await db.update(schema.works).set({ updatedAt: untouchedAt });
      const delivery = createTestDrizzleDelivery(db, {
        workContext: createWorkContextReader({
          threads: threads.threads,
          threadWorks: threads.threadWorks,
          works,
        }),
      });
      const control = postgres(DATABASE_URL, { max: 1 });
      const key = 748210499;
      const table = first === "writer" ? "turns" : "thread_works";
      const event = first === "writer" ? "INSERT" : "UPDATE";
      await control.unsafe(`
          CREATE FUNCTION test_pause_send_rebind() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END; $$;
          CREATE TRIGGER test_pause_send_rebind BEFORE ${event} ON ${table}
          FOR EACH ROW EXECUTE FUNCTION test_pause_send_rebind();
        `);
      await control`SELECT pg_advisory_lock(${key})`;
      async function waitForLock(wait: string) {
        for (let attempt = 0; attempt < 200; attempt++) {
          const rows = await control`
              SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
              AND wait_event = ${wait} AND pid <> pg_backend_pid()
            `;
          if (rows.length) return;
          await delay(10);
        }
        throw new Error(`Timed out waiting for ${wait}`);
      }
      const turnId = crypto.randomUUID();
      const writer = () =>
        persistWriterEnqueue({
          persistence: { repos: threads, eventWriter: createDrizzleEventJournalWriter(db) },
          hub: createDrizzleEventJournalReader(db),
          threadId: THREAD_ID,
          userTurnId: turnId,
          userBlocks: [{ type: "text", text: "Keep writing" }],
          delivery,
          inbox: delivery,
          draft: {
            id: turnId,
            threadId: THREAD_ID,
            intent: "message",
            provenance: { kind: "writer", actorId: USER_ID },
            body: { kind: "text", text: "Keep writing" },
            idempotencyKey: turnId,
          },
          settle: async () => "accepted",
        });
      const rebind = () =>
        handleRebindThreadWorkRequest(
          {
            threads: threads.threads,
            threadWorks: threads.threadWorks,
            projects: createDrizzleProjectRepository({ db }),
            works,
            notices,
            workContextNotices: {
              threadChanged: delivery.threadChanged,
              materializeIdle: async () => "pending",
            },
            transaction: threads.transaction,
            runClaim: createDrizzleRunClaim(db),
          },
          { threadId: THREAD_ID, userId: USER_ID, body: { workId: TARGET_WORK_ID } },
        );
      const pending: Promise<unknown>[] = [];
      try {
        pending.push(first === "writer" ? writer() : rebind());
        await waitForLock("advisory");
        pending.push(first === "writer" ? rebind() : writer());
        const results = Promise.allSettled(pending);
        await waitForLock("transactionid");
        await control`SELECT pg_advisory_unlock(${key})`;
        expect(await results).toEqual([
          expect.objectContaining({ status: "fulfilled" }),
          expect.objectContaining({ status: "fulfilled" }),
        ]);
        expect(await threads.threadWorks.listByThread(THREAD_ID)).toEqual(
          expect.arrayContaining([
            { workId: WORK_ID, isPrimary: false },
            { workId: TARGET_WORK_ID, isPrimary: true },
          ]),
        );
        const touched = await works.findById(first === "writer" ? WORK_ID : TARGET_WORK_ID);
        const untouched = await works.findById(first === "writer" ? TARGET_WORK_ID : WORK_ID);
        expect(touched?.updatedAt).not.toBe(untouchedAt.toISOString());
        expect(untouched?.updatedAt).toBe(untouchedAt.toISOString());
        expect(await threads.turns.findById(turnId)).toMatchObject({
          role: "user",
          status: "complete",
        });
        expect(await threads.threads.findById(THREAD_ID)).toMatchObject({
          activeLeafTurnId: turnId,
        });
        expect(await delivery.selectPending(THREAD_ID)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: turnId, body: { kind: "text", text: "Keep writing" } }),
          ]),
        );
      } finally {
        await control`SELECT pg_advisory_unlock(${key})`;
        await Promise.allSettled(pending);
        await control.unsafe(
          `DROP TRIGGER test_pause_send_rebind ON ${table}; DROP FUNCTION test_pause_send_rebind();`,
        );
        await control.end();
      }
    });

    it("excludes a writer rebind while another server instance owns the run", async () => {
      await threads.threadWorks.addMembership(THREAD_ID, WORK_ID, true);
      const projects = createDrizzleProjectRepository({ db });
      const modelInstance = createDrizzleRunClaim(db);
      const writerInstance = createDrizzleRunClaim(db);
      const modelClaim = await modelInstance.startExecution(THREAD_ID, "model-run");
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
              workContextNotices: {
                threadChanged: (id) => createTestDrizzleDelivery(db).threadChanged(id),
                materializeIdle: async () => "delivered" as const,
              },
              notices,
              transaction: threads.transaction,
              runClaim: writerInstance,
            },
            {
              threadId: THREAD_ID,
              userId: USER_ID,
              body: { workId: TARGET_WORK_ID },
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
        if (modelClaim) await modelInstance.release(modelClaim);
      }
      await handleRebindThreadWorkRequest(
        {
          threads: threads.threads,
          threadWorks: threads.threadWorks,
          projects,
          works,
          workContextNotices: {
            threadChanged: (id) => createTestDrizzleDelivery(db).threadChanged(id),
            materializeIdle: async () => "delivered" as const,
          },
          notices,
          transaction: threads.transaction,
          runClaim: writerInstance,
        },
        {
          threadId: THREAD_ID,
          userId: USER_ID,
          body: { workId: TARGET_WORK_ID },
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
        findNoWork: works.findNoWork.bind(works),
      };

      let thrown: unknown;
      try {
        await handleRebindThreadWorkRequest(
          {
            threads: threads.threads,
            threadWorks: threads.threadWorks,
            projects,
            works: stalePreflightWorks,
            workContextNotices: {
              threadChanged: (id) => createTestDrizzleDelivery(db).threadChanged(id),
              materializeIdle: async () => "delivered" as const,
            },
            notices,
            transaction: threads.transaction,
            runClaim: {
              withExclusiveThread: async (_threadId, operation) => operation(),
            },
          },
          {
            threadId: THREAD_ID,
            userId: USER_ID,
            body: { workId: TARGET_WORK_ID },
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
              workContextNotices: {
                threadChanged: (id) => createTestDrizzleDelivery(db).threadChanged(id),
                materializeIdle: async () => "delivered" as const,
              },
              notices,
              transaction: async (operation) => operation(),
              runClaim: {
                withExclusiveThread: async (_threadId, operation) => operation(),
              },
            },
            {
              threadId: THREAD_ID,
              userId: USER_ID,
              body: { workId: TARGET_WORK_ID },
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
          workContextNotices: {
            threadChanged: (id) => createTestDrizzleDelivery(db).threadChanged(id),
            materializeIdle: async () => "pending" as const,
          },
          notices,
          transaction: threads.transaction,
          runClaim: {
            withExclusiveThread: async (_threadId, operation) => operation(),
          },
        },
        {
          threadId: THREAD_ID,
          userId: USER_ID,
          body: { workId: TARGET_WORK_ID },
        },
      );

      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: TARGET_WORK_ID,
      });
      await expect(
        createTestDrizzleDelivery(db)
          .selectPending(THREAD_ID)
          .then((rows) => rows.length > 0),
      ).resolves.toBe(true);

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
            workContextNotices: {
              threadChanged: (id) => createTestDrizzleDelivery(db).threadChanged(id),
              materializeIdle: async () => "delivered" as const,
            },
            notices: {
              record: async () => {
                throw new Error("injected Notice failure");
              },
            },
            transaction: threads.transaction,
            runClaim: {
              withExclusiveThread: async (_threadId, operation) => operation(),
            },
          },
          {
            threadId: THREAD_ID,
            userId: USER_ID,
            body: { workId: TARGET_WORK_ID },
          },
        ),
      ).rejects.toThrow("injected Notice failure");

      await expect(threads.threadWorks.findPrimary(THREAD_ID)).resolves.toEqual({
        workId: WORK_ID,
      });
      await expect(
        createTestDrizzleDelivery(db)
          .selectPending(THREAD_ID)
          .then((rows) => rows.length > 0),
      ).resolves.toBe(false);
      await expect(notices.drainForModelContext(THREAD_ID)).resolves.toEqual([]);
    });
  });
}
