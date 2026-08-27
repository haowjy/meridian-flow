/** Postgres coverage for the default-workspace readiness fast and repair paths. */

import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("project bootstrap readiness (postgres)", () => {});
} else {
  describe("project bootstrap readiness (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../collab/composition.js");
    const { createDrizzleDocumentAccess } = await import("../../lib/document-access.js");
    const { createInMemoryEventSink } = await import("../observability/index.js");
    const { createDrizzleProjectPreferencesRepository } = await import("../preferences/index.js");
    const {
      createDrizzleProjectBootstrapRepository,
      createDrizzleProjectRepository,
      createDrizzleProjectWorkRepository,
    } = await import("./index.js");
    const { createDrizzleRepositories } = await import("../threads/adapters/drizzle/index.js");
    const { createThreadForProject } = await import("../../lib/thread-creation.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { eq } = await import("drizzle-orm");
    const { default: postgres } = await import("postgres");

    const USER_ID = "00000000-0000-4000-8000-000000000358";
    const INSERT_BARRIER_KEY = 748_210_358;
    const db = createDb(DATABASE_URL, { max: 4 });
    const lockClient = postgres(DATABASE_URL, { max: 1 });
    const observer = postgres(DATABASE_URL, { max: 1 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "bootstrap-readiness"));
    });

    afterAll(async () => {
      await db.$client.end();
      await lockClient.end();
      await observer.end();
    });

    async function waitForAdvisoryWait(queryPattern: string): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await observer<{ count: string }[]>`
          SELECT count(*)::text AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event = 'advisory'
            AND query ILIKE ${`%${queryPattern}%`}
        `;
        if (Number(row?.count ?? 0) > 0) return;
        await delay(10);
      }
      throw new Error(`Timed out waiting for advisory lock in query matching ${queryPattern}`);
    }

    function createBoundCollab() {
      const collab = createCollabDomain({
        db,
        documentAccess: createDrizzleDocumentAccess(db),
      });
      const hocuspocus = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        onStoreDocument: ({ documentName, document }) =>
          collab.storeHocuspocusDocument(documentName, document),
      });
      collab.bindHocuspocus(hocuspocus);
      return collab;
    }

    it("provisions the cold path, then stays lock-free and out of collab when ready", async () => {
      const collab = createBoundCollab();
      let seedCalls = 0;
      const coldRepository = createDrizzleProjectBootstrapRepository({
        db,
        threads: createDrizzleRepositories(db).threads,
        threadWorks: createDrizzleRepositories(db).threadWorks,
        documents: {
          ...collab,
          async seedFromMarkdown(...args: Parameters<typeof collab.seedFromMarkdown>) {
            seedCalls += 1;
            return collab.seedFromMarkdown(...args);
          },
        },
      });

      await expect(coldRepository.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(
        true,
      );
      expect(seedCalls).toBe(1);
      await expect(
        Promise.all([
          db.select({ id: schema.projects.id }).from(schema.projects),
          db.select({ id: schema.agentDefinitions.id }).from(schema.agentDefinitions),
          db.select({ id: schema.works.id }).from(schema.works),
          db.select({ id: schema.contextSources.id }).from(schema.contextSources),
          db.select({ id: schema.documents.id }).from(schema.documents),
          db.select({ id: schema.threads.id }).from(schema.threads),
        ]).then((rows) => rows.map((row) => row.length)),
      ).resolves.toEqual([1, 1, 1, 1, 2, 1]);

      const [project] = await db
        .select({ ready: schema.projects.defaultBootstrapReady })
        .from(schema.projects);
      expect(project?.ready).toBe(true);

      await lockClient`
        select pg_advisory_lock(hashtextextended(${USER_ID}, 0::bigint))
      `;
      const warmCall = coldRepository.ensureDefaultBootstrapReady(USER_ID as never);
      try {
        const outcome = await Promise.race([
          warmCall.then(() => "completed" as const),
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
        ]);
        expect(outcome).toBe("completed");
      } finally {
        await lockClient`
          select pg_advisory_unlock(hashtextextended(${USER_ID}, 0::bigint))
        `;
      }

      await expect(warmCall).resolves.toBe(true);
      expect(seedCalls).toBe(1);
    });

    it("isolates atomic bootstrap failure and provisions cleanly on a later request", async () => {
      const collab = createBoundCollab();
      const interrupted = createDrizzleProjectBootstrapRepository({
        db,
        threads: createDrizzleRepositories(db).threads,
        threadWorks: createDrizzleRepositories(db).threadWorks,
        documents: {
          ...collab,
          async seedFromMarkdown() {
            throw new Error("transient seed failure");
          },
        },
      });

      await expect(interrupted.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(false);
      await expect(db.select().from(schema.projects)).resolves.toHaveLength(0);
      await expect(db.select().from(schema.documents)).resolves.toHaveLength(0);

      const repaired = createDrizzleProjectBootstrapRepository({
        db,
        threads: createDrizzleRepositories(db).threads,
        threadWorks: createDrizzleRepositories(db).threadWorks,
        documents: collab,
      });
      await expect(repaired.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(true);

      const [ready] = await db
        .select({ ready: schema.projects.defaultBootstrapReady })
        .from(schema.projects);
      expect(ready?.ready).toBe(true);
      const [document] = await db
        .select({ id: schema.documents.id })
        .from(schema.documents)
        .where(eq(schema.documents.kind, "content"));
      expect(await collab.readAsMarkdown(document?.id as never)).toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });

    it("concurrently repairs bootstrap and creates conversations without deadlocking", async () => {
      const collab = createBoundCollab();
      const threadRepos = createDrizzleRepositories(db);
      const bootstrapRepository = createDrizzleProjectBootstrapRepository({
        db,
        threads: threadRepos.threads,
        threadWorks: threadRepos.threadWorks,
        documents: collab,
      });
      let bootstrap = await bootstrapRepository.ensureDefaultBootstrap(USER_ID as never);
      const workRepo = createDrizzleProjectWorkRepository({
        db,
        hasUnreviewedDraft: async () => false,
      });
      const createConversation = (iteration: number) =>
        createThreadForProject(
          {
            projects: createDrizzleProjectRepository({ db }),
            workRepo,
            preferences: createDrizzleProjectPreferencesRepository({ db }),
            threads: threadRepos.threads,
            threadWorks: threadRepos.threadWorks,
            transaction: threadRepos.transaction,
            eventSink: createInMemoryEventSink(),
          },
          {
            projectId: bootstrap.projectId,
            userId: USER_ID,
            workId: bootstrap.workId,
            title: `Concurrent conversation ${iteration}`,
          },
        );

      await lockClient.unsafe(`
        CREATE FUNCTION test_block_bootstrap_thread_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${INSERT_BARRIER_KEY});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_bootstrap_thread_insert
        BEFORE INSERT ON threads
        FOR EACH ROW EXECUTE FUNCTION test_block_bootstrap_thread_insert();
      `);

      try {
        for (let iteration = 0; iteration < 8; iteration += 1) {
          await db.delete(schema.threads).where(eq(schema.threads.id, bootstrap.threadId));
          await lockClient`SELECT pg_advisory_lock(${INSERT_BARRIER_KEY})`;
          let insertBarrierHeld = true;

          try {
            const conversation = createConversation(iteration);
            await waitForAdvisoryWait('insert into "threads"');

            const repair = bootstrapRepository.ensureDefaultBootstrap(USER_ID as never);
            await waitForAdvisoryWait("hashtextextended");

            await lockClient`SELECT pg_advisory_unlock(${INSERT_BARRIER_KEY})`;
            insertBarrierHeld = false;

            const [conversationResult, repairResult] = await Promise.allSettled([
              conversation,
              repair,
            ]);
            expect(conversationResult.status).toBe("fulfilled");
            expect(repairResult.status).toBe("fulfilled");
            if (conversationResult.status === "fulfilled") {
              expect(conversationResult.value.workId).toBe(bootstrap.workId);
              await expect(
                threadRepos.threadWorks.findPrimary(conversationResult.value.id as never),
              ).resolves.toEqual({ workId: bootstrap.workId });
            }
            if (repairResult.status === "fulfilled") {
              bootstrap = repairResult.value;
              await expect(
                threadRepos.threadWorks.findPrimary(bootstrap.threadId),
              ).resolves.toEqual({ workId: bootstrap.workId });
            }
          } finally {
            if (insertBarrierHeld) {
              await lockClient`SELECT pg_advisory_unlock(${INSERT_BARRIER_KEY})`;
            }
          }
        }
      } finally {
        await lockClient.unsafe(`
          DROP TRIGGER IF EXISTS test_block_bootstrap_thread_insert ON threads;
          DROP FUNCTION IF EXISTS test_block_bootstrap_thread_insert();
        `);
      }
    });
  });
}
