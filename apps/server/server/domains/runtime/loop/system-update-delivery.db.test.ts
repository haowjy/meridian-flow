/** PostgreSQL coverage for durable, atomic Work-context delivery obligations. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000711";
const PROJECT_ID = "00000000-0000-4000-8000-000000000712";
const THREAD_ID = "00000000-0000-4000-8000-000000000713";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Work-context delivery (postgres)", () => {});
} else {
  describe("Work-context delivery (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { count, eq } = await import("drizzle-orm");
    const { createDrizzleProjectPreferencesRepository } = await import(
      "../../preferences/index.js"
    );
    const { createWork } = await import("../../projects/create-work.js");
    const { createDrizzleProjectWorkRepository } = await import("../../projects/index.js");
    const { restoreWork } = await import("../../projects/delete-work.js");
    const { createDrizzleEventJournalWriter } = await import("../../threads/index.js");
    const { createDrizzleRepositories } = await import("../../threads/adapters/drizzle/index.js");
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createSystemUpdateDelivery } = await import("./system-update-delivery.js");
    const { createDrizzleThreadRunOwnership } = await import(
      "../adapters/drizzle-thread-run-ownership.js"
    );
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
    });

    afterAll(async () => {
      await db.close();
    });

    function delivery(
      repos: ReturnType<typeof createDrizzleRepositories>,
      eventWriter = createDrizzleEventJournalWriter(db),
      runOwnership = sharedRunOwnership,
    ) {
      return createSystemUpdateDelivery({
        repos,
        eventWriter,
        workContext: {
          async renderForThread() {
            return "<work_context>current state</work_context>";
          },
        },
        isThreadRunning: () => false,
        runOwnership,
        schedulePostCommit() {},
      });
    }

    it("rolls enqueue back with its transaction and coalesces repeated requests", async () => {
      const repos = createDrizzleRepositories(db);
      await expect(
        repos.transaction(async () => {
          await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
          throw new Error("business mutation rolled back");
        }),
      ).rejects.toThrow("business mutation rolled back");
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(false);

      await repos.transaction(async () => {
        await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
        await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
      });
      const [row] = await db
        .select({ value: count() })
        .from(schema.workContextDeliveryObligations)
        .where(eq(schema.workContextDeliveryObligations.threadId, THREAD_ID));
      expect(row?.value).toBe(1);
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
          preferences: createDrizzleProjectPreferencesRepository({ db }),
          contextUpdates: delivery(repos),
        },
        USER_ID,
        {
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Committed Home Work",
        },
      );
      const failingWriter = {
        async appendEvent() {
          throw new Error("journal unavailable");
        },
      };

      await expect(delivery(repos, failingWriter as never).beforeTurn(THREAD_ID)).rejects.toThrow(
        "journal unavailable",
      );
      await expect(works.findById(created.id)).resolves.toMatchObject({
        name: "Committed Home Work",
      });
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
      await expect(delivery(repos, failingWriter as never).beforeTurn(THREAD_ID)).rejects.toThrow(
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
      expect(events?.value).toBe(2);
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
      expect(staleRenderedContext).toContain("Old Work Name");
      await repos.transaction(async () => {
        await works.update(work.id, { name: "New Work Name", goal: "New goal" });
        await repos.workContextDeliveries.enqueueProject(PROJECT_ID);
      });
      await repos.threads.bakeComposedSystemPrompt(THREAD_ID, {
        composedSystemPrompt: staleRenderedContext,
        bakedSkillSlugs: [],
      });

      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
      await createSystemUpdateDelivery({
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

    it("serializes restore and enqueues only the transition that actually restores", async () => {
      const works = createDrizzleProjectWorkRepository({
        db,
        hasUnreviewedDraft: async () => false,
      });
      const work = await works.create({
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Restorable",
      });
      await works.softDelete(work.id);
      const repos = createDrizzleRepositories(db);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let firstEnqueues = 0;
      let secondEnqueues = 0;
      let entered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });

      const first = restoreWork(
        {
          works,
          contextUpdates: {
            async projectChanged(projectId) {
              firstEnqueues += 1;
              await repos.workContextDeliveries.enqueueProject(projectId);
              entered();
              await gate;
            },
          },
        },
        work.id,
      );
      await firstEntered;
      const second = restoreWork(
        {
          works,
          contextUpdates: {
            async projectChanged(projectId) {
              secondEnqueues += 1;
              await repos.workContextDeliveries.enqueueProject(projectId);
            },
          },
        },
        work.id,
      );
      const secondState = await Promise.race([
        second.then(() => "completed"),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 30)),
      ]);
      expect(secondState).toBe("blocked");
      release();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(firstEnqueues).toBe(1);
      expect(secondEnqueues).toBe(0);
      await expect(repos.workContextDeliveries.isPending(THREAD_ID)).resolves.toBe(true);
    });
  });
}
