/** PostgreSQL coverage for runtime Work-context claims and model-visible delivery. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000711";
const PROJECT_ID = "00000000-0000-4000-8000-000000000712";
const THREAD_ID = "00000000-0000-4000-8000-000000000713";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000714";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Work-context runtime delivery (postgres)", () => {});
} else {
  describe("Work-context runtime delivery (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { count, eq } = await import("drizzle-orm");
    const { createWork } = await import("../../projects/create-work.js");
    const { createDrizzleProjectWorkRepository } = await import("../../projects/index.js");
    const {
      createDrizzleEventJournalReader,
      createDrizzleEventJournalWriter,
      createThreadEventHub,
    } = await import("../../threads/index.js");
    const { createDrizzleRepositories } = await import("../../threads/adapters/drizzle/index.js");
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createWorkContextDelivery } = await import("./work-context-delivery.js");
    const { createTurnRunner } = await import("./turn-runner.js");
    const { createDrizzleThreadRunOwnership } = await import(
      "../adapters/drizzle-thread-run-ownership.js"
    );
    const { createInMemoryEventSink } = await import("../../observability/index.js");
    const { createWorkContextReader } = await import("./work-context.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 6 });
    const sharedRunOwnership = createDrizzleThreadRunOwnership(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "work-context-delivery"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Work Context Delivery",
        slug: "work-context-delivery",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Frozen thread",
        bakedSkillSlugs: [],
        composedSystemPrompt: "Frozen prompt",
      });
      await db.insert(schema.threads).values({
        id: OTHER_THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Other frozen thread",
        bakedSkillSlugs: [],
        composedSystemPrompt: "Frozen prompt",
      });
    });

    afterAll(async () => {
      await db.close();
    });

    function delivery(
      repos: ReturnType<typeof createDrizzleRepositories>,
      eventWriter = createDrizzleEventJournalWriter(db),
      runOwnership = sharedRunOwnership,
    ) {
      return createWorkContextDelivery({
        repos,
        eventWriter,
        workContext: {
          async renderForThread() {
            return {
              text: "<work_context>current state</work_context>",
              current: {
                projectId: "00000000-0000-0000-0000-000000000001",
                workId: "00000000-0000-0000-0000-000000000002",
              },
            };
          },
        },
        isThreadRunning: () => false,
        runOwnership,
        schedulePostCommit() {},
      });
    }

    it("revalidates deliverability when deletion wins after pending selection", async () => {
      const repos = createDrizzleRepositories(db);
      await repos.workContextDeliveries.enqueueThread(THREAD_ID);
      let entered!: () => void;
      const claimEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runOwnership = {
        async tryAcquire() {
          entered();
          await claimGate;
          return { async release() {} };
        },
      };

      const sweeping = delivery(repos, createDrizzleEventJournalWriter(db), runOwnership).sweep();
      await claimEntered;
      await db
        .update(schema.threads)
        .set({ deletedAt: new Date() })
        .where(eq(schema.threads.id, THREAD_ID));
      release();

      await expect(sweeping).resolves.toBeUndefined();
      await expect(repos.turns.listByThread(THREAD_ID)).resolves.toHaveLength(0);
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
      await expect(delivery(repos).sweep()).resolves.toBeUndefined();
    });

    it("survives recreation and repeated append failure, then atomically appends and acknowledges", async () => {
      const repos = createDrizzleRepositories(db);
      const works = createDrizzleProjectWorkRepository({
        db,
        hasUnreviewedDraft: async () => false,
      });
      const created = await createWork(
        {
          works,
          workContextDelivery: delivery(repos),
        },
        {
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Committed Home Work",
        },
      );
      const failingWriter = {
        ...createDrizzleEventJournalWriter(db),
        async appendEvent() {
          throw new Error("journal unavailable");
        },
      };

      await expect(delivery(repos, failingWriter).beforeTurn(THREAD_ID)).rejects.toThrow(
        "journal unavailable",
      );
      await expect(works.findById(created.id)).resolves.toMatchObject({
        name: "Committed Home Work",
      });
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
      await expect(delivery(repos, failingWriter).beforeTurn(THREAD_ID)).rejects.toThrow(
        "journal unavailable",
      );
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);

      await delivery(createDrizzleRepositories(db)).sweep();
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);
      await expect(repos.turns.listByThread(THREAD_ID)).resolves.toHaveLength(1);
      const [events] = await db
        .select({ value: count() })
        .from(schema.eventJournal)
        .where(eq(schema.eventJournal.threadId, THREAD_ID));
      expect(events?.value).toBe(3);
    });

    it("admits one update across concurrent process claims", async () => {
      const first = createDrizzleRepositories(db);
      const second = createDrizzleRepositories(db);
      await first.workContextDeliveries.enqueueThread(THREAD_ID);

      await Promise.all([
        delivery(first).beforeTurn(THREAD_ID),
        delivery(second).beforeTurn(THREAD_ID),
      ]);

      await expect(first.turns.listByThread(THREAD_ID)).resolves.toHaveLength(1);
      await expect(first.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);
    });

    it("refuses same-process reentry without disturbing other session claims", async () => {
      const ownership = createDrizzleThreadRunOwnership(db);
      const first = await ownership.tryAcquire(THREAD_ID);
      expect(first).not.toBeNull();

      await expect(ownership.tryAcquire(THREAD_ID)).resolves.toBeNull();
      const other = await ownership.tryAcquire(OTHER_THREAD_ID);
      expect(other).not.toBeNull();

      const remote = createDrizzleThreadRunOwnership(db);
      await expect(remote.tryAcquire(THREAD_ID)).resolves.toBeNull();
      await expect(remote.tryAcquire(OTHER_THREAD_ID)).resolves.toBeNull();

      await first?.release();
      const remoteFirst = await remote.tryAcquire(THREAD_ID);
      expect(remoteFirst).not.toBeNull();
      await expect(remote.tryAcquire(OTHER_THREAD_ID)).resolves.toBeNull();

      await other?.release();
      const remoteOther = await remote.tryAcquire(OTHER_THREAD_ID);
      expect(remoteOther).not.toBeNull();
      await remoteFirst?.release();
      await remoteOther?.release();

      const replacement = await ownership.tryAcquire(THREAD_ID);
      expect(replacement).not.toBeNull();
      await first?.release();
      await expect(remote.tryAcquire(THREAD_ID)).resolves.toBeNull();
      await replacement?.release();
      const finalRemote = await remote.tryAcquire(THREAD_ID);
      expect(finalRemote).not.toBeNull();
      await finalRemote?.release();
    });

    it("runs one primary turn across concurrent starts on the same production adapter", async () => {
      let runTurnCalls = 0;
      const runner = createTurnRunner({
        workContextDelivery: { async beforeTurn() {}, async flushOwned() {} },
        orchestrator: {
          async runTurn() {
            runTurnCalls += 1;
            return {
              userTurnId: "turn-user",
              assistantTurnId: "turn-assistant",
              events: (async function* emptyEvents() {})(),
            };
          },
          async finalizeGeneratorFailure() {},
        },
        eventSink: createInMemoryEventSink(),
        hub: createThreadEventHub({
          journalReader: createDrizzleEventJournalReader(db),
          journalWriter: createDrizzleEventJournalWriter(db),
          eventSink: createInMemoryEventSink(),
        }),
        repos: { turns: createDrizzleRepositories(db).turns },
        runOwnership: createDrizzleThreadRunOwnership(db),
      });

      const starts = await Promise.allSettled([
        runner.startTurn({ threadId: THREAD_ID, userText: "first" }),
        runner.startTurn({ threadId: THREAD_ID, userText: "second" }),
      ]);

      expect(starts.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(runTurnCalls).toBe(1);
      await vi.waitUntil(() => !runner.isThreadRunning(THREAD_ID));
    });

    it("leaves a remote obligation with its live owner, then owner completion appends once", async () => {
      const ownerRepos = createDrizzleRepositories(db);
      const remoteRepos = createDrizzleRepositories(db);
      const ownerOwnership = createDrizzleThreadRunOwnership(db);
      const remoteOwnership = createDrizzleThreadRunOwnership(db);
      const ownerClaim = await ownerOwnership.tryAcquire(THREAD_ID);
      expect(ownerClaim).not.toBeNull();
      await ownerRepos.workContextDeliveries.enqueueThread(THREAD_ID);

      await delivery(remoteRepos, createDrizzleEventJournalWriter(db), remoteOwnership).sweep();

      await expect(remoteRepos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
      await expect(remoteRepos.turns.listByThread(THREAD_ID)).resolves.toHaveLength(0);

      const ownerDelivery = delivery(
        ownerRepos,
        createDrizzleEventJournalWriter(db),
        ownerOwnership,
      );
      await ownerDelivery.flushOwned(THREAD_ID);
      const turns = await ownerRepos.turns.listByThread(THREAD_ID);
      expect(turns).toHaveLength(1);
      const blocks = await ownerRepos.blocks.listByTurn(turns[0]?.id ?? "");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.textContent).toContain("<work_context>current state</work_context>");
      await expect(ownerRepos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);

      await ownerClaim?.release();
      await delivery(remoteRepos, createDrizzleEventJournalWriter(db), remoteOwnership).sweep();
      await expect(ownerRepos.turns.listByThread(THREAD_ID)).resolves.toHaveLength(1);
    });

    it("leaves a durable refresh when a Work changes between first render and freeze", async () => {
      const repos = createDrizzleRepositories(db);
      const works = createDrizzleProjectWorkRepository({
        db,
        hasUnreviewedDraft: async () => false,
      });
      const work = await works.create({
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Old Work Name",
        goal: "Old goal",
      });
      await repos.threadWorks.addMembership(THREAD_ID, work.id, true);
      await db
        .update(schema.threads)
        .set({ bakedSkillSlugs: null, composedSystemPrompt: null })
        .where(eq(schema.threads.id, THREAD_ID));
      const workContext = createWorkContextReader({ works, threadWorks: repos.threadWorks });

      const staleRenderedContext = await workContext.renderForThread(THREAD_ID);
      expect(staleRenderedContext.text).toContain("Old Work Name");
      await repos.transaction(async () => {
        await works.update(work.id, { name: "New Work Name", goal: "New goal" });
        await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
      });
      await repos.threads.bakeComposedSystemPrompt(THREAD_ID, {
        composedSystemPrompt: staleRenderedContext.text,
        bakedSkillSlugs: [],
      });

      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
      await createWorkContextDelivery({
        repos,
        eventWriter: createDrizzleEventJournalWriter(db),
        workContext,
        isThreadRunning: () => false,
        schedulePostCommit() {},
      }).beforeTurn(THREAD_ID);

      const turns = await repos.turns.listByThread(THREAD_ID);
      const blocks = await repos.blocks.listByTurn(turns.at(-1)?.id ?? "");
      expect(blocks[0]?.textContent).toContain("New Work Name");
      expect(blocks[0]?.textContent).not.toContain("Old Work Name");
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);
    });

    it("hydrates a competing deliverNow claim as idempotent success", async () => {
      const first = createDrizzleRepositories(db);
      const second = createDrizzleRepositories(db);
      await first.workContextDeliveries.enqueueThread(THREAD_ID);

      const [firstResult, secondResult] = await Promise.all([
        delivery(first).deliverNow(THREAD_ID),
        delivery(second).deliverNow(THREAD_ID),
      ]);

      expect(firstResult.turn.id).toBe(secondResult.turn.id);
      expect(firstResult.block.id).toBe(secondResult.block.id);
      await expect(first.turns.listByThread(THREAD_ID)).resolves.toHaveLength(1);
      await expect(first.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);
    });
  });
}
