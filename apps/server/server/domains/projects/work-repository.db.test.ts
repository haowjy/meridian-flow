/** Postgres coverage for Work handles, cascaded soft deletion, and restore conflicts. */
import { setTimeout as delay } from "node:timers/promises";
import { canonicalContextUri } from "@meridian/contracts/context-uri";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDrizzleDelivery } from "../runtime/loop/__tests__/test-drizzle-delivery.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000841";
const PROJECT_ID = "00000000-0000-4000-8000-000000000842";
const THREAD_ID = "00000000-0000-4000-8000-000000000843";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Work repository lifecycle (postgres)", () => {});
} else {
  describe("Work repository lifecycle (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createDrizzleProjectContextAvailability } = await import(
      "../context/adapters/project-context-availability.js"
    );
    const { createDrizzleContextCatalog } = await import("../context/adapters/context-catalog.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../threads/adapters/drizzle/repositories.js"
    );
    const {
      createDrizzleProjectWorkRepository,
      createDrizzleProjectWorkAuthorityResolver,
      deleteWorkTransition,
      restoreWork,
      updateWorkTransition,
      WorkRestoreConflictError,
      WorkRestoreExpiredError,
      createWorkProjectionMutation,
      createDrizzleWorkPurger,
    } = await import("./index.js");
    const { createInMemoryObjectStore } = await import("../storage/index.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const availability = createDrizzleProjectContextAvailability(db);
    const catalog = createDrizzleContextCatalog(db, undefined, {
      availabilityMutations: availability,
    });
    const projectionMutation = createWorkProjectionMutation({
      db,
      availability,
      catalog,
    });
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
      projectionMutation,
    });
    const threadRepos = createDrizzleRepositoriesForTest(db);
    const authorities = createDrizzleProjectWorkAuthorityResolver(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "work-repository"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Work Repository",
        slug: "work-repository",
      });
    });

    afterAll(async () => {
      await control.end();
      await db.close();
    });

    async function waitForLock(waitEvent: string, minimum = 1): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await control<{ count: string }[]>`
          SELECT count(*)::text AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event = ${waitEvent}
        `;
        if (Number(row?.count ?? 0) >= minimum) return;
        await delay(10);
      }
      throw new Error(`Timed out waiting for ${minimum} PostgreSQL ${waitEvent} lock(s)`);
    }

    it("deletes and restores archived management identity without unarchiving it", async () => {
      const work = await works.create({ projectId: PROJECT_ID, name: "Archived history" });
      await works.archive(work.id);
      await works.softDelete(work.id);
      expect(await works.findById(work.id)).toMatchObject({
        status: "archived",
        deletedAt: expect.any(String),
      });
      await works.restore(work.id);
      expect(await works.findById(work.id)).toMatchObject({ status: "archived", deletedAt: null });
      await expect(authorities.byId(PROJECT_ID, work.id)).resolves.toMatchObject({
        workId: work.id,
      });
      await works.unarchive(work.id);
      expect(await works.findById(work.id)).toMatchObject({ status: "active", deletedAt: null });
    });

    it("generates deduplicated handles and keeps them through rename", async () => {
      const first = await works.create({ projectId: PROJECT_ID, name: "Book 2!" });
      const second = await works.create({ projectId: PROJECT_ID, name: "Book 2?" });
      const symbols = await works.create({ projectId: PROJECT_ID, name: "!!!" });

      expect([first.slug, second.slug, symbols.slug]).toEqual(["book-2", "book-2-2", "work"]);
      await expect(works.update(first.id, { name: "Renamed" })).resolves.toMatchObject({
        slug: "book-2",
      });
    });

    it("keeps UUID-shaped slugs and resolves ambiguous strings by exact field role", async () => {
      const ambiguous = "123e4567-e89b-12d3-a456-426614174000";
      const byIdWork = await works.create({ id: ambiguous, projectId: PROJECT_ID, name: "Alpha" });
      const bySlugWork = await works.create({ projectId: PROJECT_ID, name: ambiguous });
      const collision = await works.create({ projectId: PROJECT_ID, name: `${ambiguous}!` });

      expect([bySlugWork.slug, collision.slug]).toEqual([ambiguous, `${ambiguous}-2`]);
      const idAuthority = await authorities.byId(PROJECT_ID, byIdWork.id);
      if (!bySlugWork.slug) throw new Error("named Work missing slug");
      const slugAuthority = await authorities.bySlug(PROJECT_ID, bySlugWork.slug);
      expect(idAuthority).toMatchObject({ workId: byIdWork.id, workSlug: "alpha" });
      expect(slugAuthority).toMatchObject({ workId: bySlugWork.id, workSlug: ambiguous });
      if (!idAuthority || !slugAuthority) throw new Error("missing resolved authority");
      expect(canonicalContextUri("scratch", "notes.md", idAuthority)).toBe(
        "scratch://@alpha/notes.md",
      );
      expect(canonicalContextUri("scratch", "notes.md", slugAuthority)).toBe(
        `scratch://@${ambiguous}/notes.md`,
      );
    });

    it("captures update and delete receipts from the locked committing transition", async () => {
      const work = await works.create({ projectId: PROJECT_ID, name: "A" });
      let releaseUpdate!: () => void;
      let updateLocked!: () => void;
      const updateGate = new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      const updateHasLock = new Promise<void>((resolve) => {
        updateLocked = resolve;
      });
      const concurrentUpdate = works.transaction(async () => {
        await works.lockById(work.id);
        updateLocked();
        await updateGate;
        await works.update(work.id, { name: "B" });
      });
      await updateHasLock;
      const commandUpdate = updateWorkTransition(
        { works, workContextNotices: { async projectChanged() {} } },
        work.id,
        { name: "C" },
      );
      await waitForLock("transactionid");
      releaseUpdate();
      await concurrentUpdate;
      await expect(commandUpdate).resolves.toMatchObject({
        before: { name: "B" },
        after: { name: "C" },
        changed: true,
      });

      let releaseDelete!: () => void;
      let deleteLocked!: () => void;
      const deleteGate = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      const deleteHasLock = new Promise<void>((resolve) => {
        deleteLocked = resolve;
      });
      const concurrentDelete = works.transaction(async () => {
        await works.lockById(work.id);
        deleteLocked();
        await deleteGate;
        await works.softDelete(work.id);
      });
      await deleteHasLock;
      const commandDelete = deleteWorkTransition(
        { works, workContextNotices: { async projectChanged() {} } },
        work.id,
      );
      await waitForLock("transactionid");
      releaseDelete();
      await concurrentDelete;
      await expect(commandDelete).resolves.toMatchObject({ changed: false });
    });

    it("serializes Work restore and enqueues only the transition that restores", async () => {
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Work restore observer",
      });
      const work = await works.create({ projectId: PROJECT_ID, name: "Restorable" });
      await works.softDelete(work.id);
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
          workContextNotices: {
            async projectChanged(projectId) {
              firstEnqueues += 1;
              await createTestDrizzleDelivery(db).projectChanged(projectId);
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
          workContextNotices: {
            async projectChanged(projectId) {
              secondEnqueues += 1;
              await createTestDrizzleDelivery(db).projectChanged(projectId);
            },
          },
        },
        work.id,
      );
      const secondState = await Promise.race([
        second.then(() => "completed"),
        delay(30, "blocked"),
      ]);
      expect(secondState).toBe("blocked");
      release();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(firstEnqueues).toBe(1);
      expect(secondEnqueues).toBe(0);
      await expect(
        createTestDrizzleDelivery(db)
          .selectPending(THREAD_ID)
          .then((rows) => rows.length > 0),
      ).resolves.toBe(true);
    });

    it("makes identical locked updates storage no-ops and applies real changes once", async () => {
      const work = await works.create({
        projectId: PROJECT_ID,
        name: "Semantic state",
        goal: "Finish it",
      });
      const deps = { works, workContextNotices: { async projectChanged() {} } };
      await control.unsafe(`
        CREATE SEQUENCE test_work_update_count;
        CREATE FUNCTION test_count_work_update() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM nextval('test_work_update_count');
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_count_work_update
        BEFORE UPDATE ON works
        FOR EACH ROW EXECUTE FUNCTION test_count_work_update();
      `);

      async function updateCount(): Promise<number> {
        const [row] = await control<{ last_value: string; is_called: boolean }[]>`
          SELECT last_value::text, is_called FROM test_work_update_count
        `;
        return row?.is_called ? Number(row.last_value) : 0;
      }

      try {
        const identical = await updateWorkTransition(deps, work.id, {
          name: " Semantic state ",
          goal: "Finish it",
          status: "active",
        });
        expect(identical).toEqual({ before: work, after: work, changed: false });
        await expect(updateCount()).resolves.toBe(0);

        await expect(updateWorkTransition(deps, work.id, {})).resolves.toMatchObject({
          changed: false,
          after: { goal: "Finish it" },
        });
        await expect(updateCount()).resolves.toBe(0);

        let releaseLock!: () => void;
        let hasLock!: () => void;
        const lockGate = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        const locked = new Promise<void>((resolve) => {
          hasLock = resolve;
        });
        const holder = works.transaction(async () => {
          await works.lockById(work.id);
          hasLock();
          await lockGate;
        });
        await locked;
        const concurrent = [
          updateWorkTransition(deps, work.id, { name: "Semantic state", status: "active" }),
          updateWorkTransition(deps, work.id, {
            goal: "Finish it",
          }),
        ];
        await waitForLock("transactionid");
        releaseLock();
        await holder;
        await expect(Promise.all(concurrent)).resolves.toMatchObject([
          { changed: false },
          { changed: false },
        ]);
        await expect(updateCount()).resolves.toBe(0);

        const cleared = await updateWorkTransition(deps, work.id, { goal: null });
        expect(cleared).toMatchObject({
          before: { goal: "Finish it" },
          after: { goal: null },
          changed: true,
        });
        await expect(updateCount()).resolves.toBe(1);

        const archived = await updateWorkTransition(deps, work.id, { status: "archived" });
        expect(archived).toMatchObject({ after: { status: "archived" }, changed: true });
        await expect(updateCount()).resolves.toBe(2);
        await expect(
          updateWorkTransition(deps, work.id, { status: "archived" }),
        ).resolves.toMatchObject({ changed: false });
        await expect(updateCount()).resolves.toBe(2);

        const unarchived = await updateWorkTransition(deps, work.id, { status: "active" });
        expect(unarchived).toMatchObject({
          before: { status: "archived" },
          after: { status: "active", archivedAt: null },
          changed: true,
        });
        await expect(updateCount()).resolves.toBe(3);

        const beforeRealChange = unarchived.after;
        const realChange = await updateWorkTransition(deps, work.id, {
          name: "Revised semantic state",
          goal: "New goal",
        });
        expect(realChange).toMatchObject({
          before: {
            name: beforeRealChange.name,
            goal: beforeRealChange.goal,
          },
          after: {
            name: "Revised semantic state",
            goal: "New goal",
          },
          changed: true,
        });
        expect(realChange.after.updatedAt).not.toBe(beforeRealChange.updatedAt);
        expect(realChange.after.lastActivityAt).toBe(realChange.after.updatedAt);
        await expect(updateCount()).resolves.toBe(4);
      } finally {
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_count_work_update ON works;
          DROP FUNCTION IF EXISTS test_count_work_update();
          DROP SEQUENCE IF EXISTS test_work_update_count;
        `);
      }
    });

    it("reserves deleted Work slugs but refuses a reclaimed name", async () => {
      const available = await works.create({ projectId: PROJECT_ID, name: "Available" });
      await works.softDelete(available.id);
      await expect(works.restore(available.id)).resolves.toMatchObject({
        after: { deletedAt: null },
        changed: true,
      });

      const nameOwner = await works.create({ projectId: PROJECT_ID, name: "Reclaimed" });
      await works.softDelete(nameOwner.id);
      await works.create({ projectId: PROJECT_ID, name: "Reclaimed" });
      await expect(works.restore(nameOwner.id)).rejects.toEqual(
        new WorkRestoreConflictError("name"),
      );

      const slugOwner = await works.create({ projectId: PROJECT_ID, name: "Same slug!" });
      await works.softDelete(slugOwner.id);
      expect((await works.create({ projectId: PROJECT_ID, name: "Same slug?" })).slug).toBe(
        "same-slug-2",
      );
      await expect(works.restore(slugOwner.id)).resolves.toMatchObject({
        after: { slug: "same-slug" },
        changed: true,
      });
    });

    it("deletes content and restores only rows hidden by the Work deletion", async () => {
      const empty = await works.create({ projectId: PROJECT_ID, name: "Empty source" });
      await db.insert(schema.contextSources).values({
        workId: empty.id,
        name: "Scratch",
        slug: "scratch",
        scope: "work",
      });
      await expect(works.softDelete(empty.id)).resolves.toMatchObject({
        after: { deletedAt: expect.any(String) },
      });

      const withFile = await works.create({ projectId: PROJECT_ID, name: "With file" });
      const [source] = await db
        .insert(schema.contextSources)
        .values({ workId: withFile.id, name: "Uploads", slug: "uploads", scope: "work" })
        .returning();
      if (!source) throw new Error("Expected context source");
      await db
        .insert(schema.documents)
        .values({
          contextSourceId: source.id,
          name: "reference",
        })
        .returning();
      const [alreadyDeletedDocument] = await db
        .insert(schema.documents)
        .values({
          contextSourceId: source.id,
          name: "separately-deleted",
          deletedAt: new Date("2025-01-01T00:00:00.000Z"),
        })
        .returning();
      const [folder] = await db
        .insert(schema.folders)
        .values({ contextSourceId: source.id, name: "Notes" })
        .returning();
      const [alreadyDeletedFolder] = await db
        .insert(schema.folders)
        .values({
          contextSourceId: source.id,
          name: "separately-deleted",
          deletedAt: new Date("2025-01-01T00:00:00.000Z"),
        })
        .returning();
      if (!folder || !alreadyDeletedFolder || !alreadyDeletedDocument) {
        throw new Error("Expected context children");
      }

      const deletion = await works.softDelete(withFile.id);
      expect(deletion.after?.deletedAt).toBeTruthy();
      await expect(
        db
          .select()
          .from(schema.documents)
          .where(eq(schema.documents.id, alreadyDeletedDocument.id)),
      ).resolves.toMatchObject([
        { deletedAt: new Date("2025-01-01T00:00:00.000Z"), deletedByWorkId: null },
      ]);
      await expect(works.restore(withFile.id)).resolves.toMatchObject({
        after: { deletedAt: null },
        changed: true,
      });
      await expect(
        db.select().from(schema.contextSources).where(eq(schema.contextSources.id, source.id)),
      ).resolves.toMatchObject([{ deletedAt: null, deletedByWorkId: null }]);
      await expect(
        db
          .select()
          .from(schema.documents)
          .where(eq(schema.documents.id, alreadyDeletedDocument.id)),
      ).resolves.toMatchObject([
        { deletedAt: new Date("2025-01-01T00:00:00.000Z"), deletedByWorkId: null },
      ]);
      await expect(
        db.select().from(schema.folders).where(eq(schema.folders.id, folder.id)),
      ).resolves.toMatchObject([{ deletedAt: null, deletedByWorkId: null }]);
      await expect(
        db.select().from(schema.folders).where(eq(schema.folders.id, alreadyDeletedFolder.id)),
      ).resolves.toMatchObject([
        { deletedAt: new Date("2025-01-01T00:00:00.000Z"), deletedByWorkId: null },
      ]);
    });

    it("hides Work chats, drafts, and context from their read surfaces, then restores them", async () => {
      await works.ensureNoWork(PROJECT_ID);
      const work = await works.create({ projectId: PROJECT_ID, name: "Hidden Work" });
      const [source] = await db
        .insert(schema.contextSources)
        .values({ workId: work.id, name: "Scratch", slug: "scratch", scope: "work" })
        .returning();
      if (!source) throw new Error("Expected Work context source");
      const [document] = await db
        .insert(schema.documents)
        .values({ contextSourceId: source.id, name: "outline" })
        .returning();
      if (!document) throw new Error("Expected Work document");
      await db.insert(schema.documentBranches).values({
        id: "work-delete-draft",
        documentId: document.id,
        kind: "work_draft",
        workId: work.id,
        state: Buffer.from([]),
        stateVector: Buffer.from([]),
      });
      const resultTurnId = "00000000-0000-4000-8000-000000000848";
      const resultId = "00000000-0000-4000-8000-000000000849";
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Bound chat",
      });
      await db.insert(schema.turns).values({
        id: resultTurnId,
        threadId: THREAD_ID,
        role: "assistant",
        origin: "assistant",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: work.id,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
      const { createDrizzleResultRepository } = await import(
        "../context/promotion/adapters/drizzle-result-repository.js"
      );
      const resultRepository = createDrizzleResultRepository(db);
      await expect(
        resultRepository.createOrConverge({
          id: resultId,
          projectId: PROJECT_ID,
          sourcePath: "reports/final.txt",
          resultsUri: "results://@hidden-work/threads/root/reports/final.txt",
          storageUrl: "memory://work-result",
          mimeType: "text/plain",
          sizeBytes: 4,
          provenance: {
            rootThreadId: THREAD_ID as never,
            threadId: THREAD_ID as never,
            turnId: resultTurnId as never,
            toolCallId: "call-work-result",
          },
        }),
      ).resolves.toMatchObject({ kind: "committed" });
      const childThreadId = "00000000-0000-4000-8000-000000000845";
      await db.insert(schema.threads).values({
        id: childThreadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Bound chat subagent",
        kind: "subagent",
        parentThreadId: THREAD_ID,
        rootThreadId: THREAD_ID,
        originTurnId: THREAD_ID,
        originType: "spawn",
        spawnStatus: "succeeded",
        spawnDepth: 1,
      });
      const separatelyDeletedThreadId = "00000000-0000-4000-8000-000000000844";
      await db.insert(schema.threads).values({
        id: separatelyDeletedThreadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Previously trashed chat",
      });
      await db.insert(schema.threadWorks).values({
        threadId: separatelyDeletedThreadId,
        workId: work.id,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
      await threadRepos.threads.setTrashState(separatelyDeletedThreadId as never, "deleted");

      const feedInput = {
        projectId: PROJECT_ID as never,
        userId: USER_ID as never,
        after: null,
        limit: 20,
        favorite: false,
        workId: null,
        search: null,
      };
      const scope = { kind: "work", projectId: PROJECT_ID, workId: work.id } as const;
      await expect(threadRepos.threads.findById(THREAD_ID as never)).resolves.toMatchObject({
        id: THREAD_ID,
      });
      await expect(threadRepos.threads.findById(childThreadId as never)).resolves.toMatchObject({
        id: childThreadId,
      });
      await expect(threadRepos.chatFeed.queryPage(feedInput)).resolves.toHaveLength(1);
      await expect(
        threadRepos.threads.listRecentByWork(PROJECT_ID as never, work.id, 10),
      ).resolves.toHaveLength(1);
      await expect(resultRepository.listByProject(PROJECT_ID)).resolves.toHaveLength(1);
      expect((await catalog.snapshot(scope)).entries.map((entry) => entry.entryId)).toContain(
        document.id,
      );

      const deletion = await works.softDelete(work.id);
      expect(new Set(deletion.threadIds)).toEqual(new Set([THREAD_ID, childThreadId]));
      await expect(
        resultRepository.createOrConverge({
          id: "00000000-0000-4000-8000-000000000850",
          projectId: PROJECT_ID,
          sourcePath: "reports/late.txt",
          resultsUri: "results://@hidden-work/threads/root/reports/late.txt",
          storageUrl: "memory://late-work-result",
          mimeType: "text/plain",
          sizeBytes: 4,
          provenance: {
            rootThreadId: THREAD_ID as never,
            threadId: THREAD_ID as never,
            turnId: resultTurnId as never,
            toolCallId: "call-late-work-result",
          },
        }),
      ).resolves.toMatchObject({ kind: "definitely_not_committed" });
      await expect(threadRepos.threads.findById(THREAD_ID as never)).resolves.toBeNull();
      await expect(threadRepos.threads.findById(childThreadId as never)).resolves.toBeNull();
      await expect(threadRepos.chatFeed.queryPage(feedInput)).resolves.toEqual([]);
      await expect(
        threadRepos.threads.listRecentByWork(PROJECT_ID as never, work.id, 10),
      ).resolves.toEqual([]);
      await expect(resultRepository.listByProject(PROJECT_ID)).resolves.toEqual([]);
      expect((await catalog.snapshot(scope)).entries).toEqual([]);
      const { restoreOwnedThreadFromTrash } = await import("../threads/thread-access.js");
      const threadTrashDeps = {
        repos: threadRepos,
        projects: {
          async findById() {
            return { id: PROJECT_ID, userId: USER_ID, deletedAt: null } as never;
          },
        },
        workContextNotices: {
          async threadChanged() {},
          async materializeIdle() {
            return "delivered" as const;
          },
        },
        workAuthorityResolver: authorities,
        works,
      };
      for (const threadId of [THREAD_ID, childThreadId, separatelyDeletedThreadId]) {
        await expect(
          restoreOwnedThreadFromTrash(threadTrashDeps, threadId, USER_ID as never),
        ).rejects.toMatchObject({ statusCode: 404 });
      }
      await expect(
        db
          .select()
          .from(schema.documentBranches)
          .where(eq(schema.documentBranches.id, "work-delete-draft")),
      ).resolves.toMatchObject([{ status: "closed", deletedByWorkId: work.id }]);

      await works.restore(work.id);
      await expect(threadRepos.threads.findById(THREAD_ID as never)).resolves.toMatchObject({
        id: THREAD_ID,
      });
      await expect(threadRepos.threads.findById(childThreadId as never)).resolves.toMatchObject({
        id: childThreadId,
      });
      await expect(
        threadRepos.threads.findById(separatelyDeletedThreadId as never),
      ).resolves.toBeNull();
      await expect(threadRepos.chatFeed.queryPage(feedInput)).resolves.toHaveLength(1);
      await expect(
        db
          .select()
          .from(schema.documentBranches)
          .where(eq(schema.documentBranches.id, "work-delete-draft")),
      ).resolves.toMatchObject([{ status: "active", deletedByWorkId: null }]);
      expect((await catalog.snapshot(scope)).entries.map((entry) => entry.entryId)).toContain(
        document.id,
      );
      await expect(resultRepository.listByProject(PROJECT_ID)).resolves.toHaveLength(1);
    });

    it("refuses restoring a deleted Work after its retention deadline", async () => {
      const work = await works.create({ projectId: PROJECT_ID, name: "Expired Work" });
      await db
        .update(schema.works)
        .set({ deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000) })
        .where(eq(schema.works.id, work.id));
      await expect(works.restore(work.id)).rejects.toBeInstanceOf(WorkRestoreExpiredError);
    });

    it("purges expired Work rows and upload blobs without touching live Works", async () => {
      const objectStore = createInMemoryObjectStore();
      const purger = createDrizzleWorkPurger({ db, objectStore });
      const work = await works.create({ projectId: PROJECT_ID, name: "Purge me" });
      const other = await works.create({ projectId: PROJECT_ID, name: "Keep me" });
      const expiredTrashThreadId = "00000000-0000-4000-8000-000000000847";
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Purged Work chat",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: work.id,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
      const childThreadId = "00000000-0000-4000-8000-000000000846";
      await db.insert(schema.threads).values({
        id: childThreadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Purged Work subagent",
        kind: "subagent",
        parentThreadId: THREAD_ID,
        rootThreadId: THREAD_ID,
        originTurnId: THREAD_ID,
        originType: "spawn",
        spawnStatus: "succeeded",
        spawnDepth: 1,
      });
      await db.insert(schema.threads).values({
        id: expiredTrashThreadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Already trashed chat",
      });
      await db.insert(schema.threadWorks).values({
        threadId: expiredTrashThreadId,
        workId: work.id,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
      await threadRepos.threads.setTrashState(expiredTrashThreadId as never, "deleted");
      const [source] = await db
        .insert(schema.contextSources)
        .values({ workId: work.id, name: "Uploads", slug: "uploads", scope: "work" })
        .returning();
      if (!source) throw new Error("Expected Work Uploads source");
      const [document] = await db
        .insert(schema.documents)
        .values({
          contextSourceId: source.id,
          name: "reference",
          extension: "png",
          fileType: "png",
        })
        .returning();
      if (!document) throw new Error("Expected uploaded document");
      const objectKey = `uploads/${PROJECT_ID}/${document.id}`;
      const stored = await objectStore.put(objectKey, new Uint8Array([7]), "image/png");
      if (!stored.ok) throw new Error(stored.error.message);
      await db.insert(schema.uploadIntakes).values({
        projectId: PROJECT_ID,
        intakeId: "purge-intake",
        actorUserId: USER_ID,
        workId: work.id,
        contextSourceId: source.id,
        documentId: document.id,
        fingerprint: "fingerprint",
        byteDigest: "a".repeat(64),
        filename: "reference.png",
        mimeType: "image/png",
        finalPath: "reference.png",
        objectKey,
        fileType: "png",
        canonicalUri: `uploads://@${work.slug}/reference.png`,
        locationRevision: crypto.randomUUID(),
        state: "finalized",
        storageUrl: stored.value.storageUrl,
      });
      await works.softDelete(work.id);
      await db
        .update(schema.works)
        .set({ deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000) })
        .where(eq(schema.works.id, work.id));

      await expect(purger.sweep()).resolves.toBe(1);
      await expect(works.findById(work.id)).resolves.toBeNull();
      await expect(works.findById(other.id)).resolves.toMatchObject({ deletedAt: null });
      await expect(
        db
          .select({ id: schema.threads.id })
          .from(schema.threads)
          .where(
            inArray(schema.threads.id, [
              THREAD_ID as never,
              childThreadId as never,
              expiredTrashThreadId as never,
            ]),
          ),
      ).resolves.toEqual([]);
      await expect(
        db.select().from(schema.uploadIntakes).where(eq(schema.uploadIntakes.workId, work.id)),
      ).resolves.toEqual([]);
      await expect(objectStore.get(objectKey)).resolves.toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    });

    it("serializes Work content creation before deletion", async () => {
      const insertBarrier = 748_210_843;
      const work = await works.create({ projectId: PROJECT_ID, name: "Creation race" });
      const { createWorkContextDocumentStore } = await import("../context/index.js");
      const store = createWorkContextDocumentStore(db, work.id, "uploads");
      await control.unsafe(`
        CREATE FUNCTION test_block_work_document_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${insertBarrier});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_work_document_insert
        BEFORE INSERT ON documents
        FOR EACH ROW EXECUTE FUNCTION test_block_work_document_insert();
      `);
      await control`SELECT pg_advisory_lock(${insertBarrier})`;
      let barrierHeld = true;

      try {
        const creation = store.createBinaryDocument({
          folderId: null,
          name: "reference",
          extension: "pdf",
          fileType: "pdf",
          storageUrl: "s3://test/reference.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
        });
        await waitForLock("advisory");
        const deletion = works.softDelete(work.id).then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        await waitForLock("transactionid");

        await control`SELECT pg_advisory_unlock(${insertBarrier})`;
        barrierHeld = false;
        await creation;
        const result = await deletion;

        expect(result.status).toBe("fulfilled");
        await expect(works.findById(work.id)).resolves.toMatchObject({
          deletedAt: expect.any(String),
        });
      } finally {
        if (barrierHeld) await control`SELECT pg_advisory_unlock(${insertBarrier})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_work_document_insert ON documents;
          DROP FUNCTION IF EXISTS test_block_work_document_insert();
        `);
      }
    });
  });
}
