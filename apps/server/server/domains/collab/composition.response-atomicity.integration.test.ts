/** Real-Postgres coverage for response-wide durability and process-local rollback. */
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { BranchSnapshot } from "./domain/branch-coordinator.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("response atomicity (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("response atomicity (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDrizzleNoticePort } = await import("../notices/index.js");
    const { createActiveDocumentResolver } = await import("../threads/index.js");
    const { createDrizzleRepositories } = await import("../threads/adapters/drizzle/index.js");
    const { runInDrizzleTransaction, runInRootDrizzleTransaction } = await import(
      "../../shared/drizzle-transaction.js"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createDrizzleBranchPushStore } = await import("./adapters/drizzle-branch-push.js");
    const { createChangeTrailDeliveryDispatcher } = await import(
      "./adapters/drizzle-change-trail-delivery.js"
    );
    const { createDrizzleChangeTrailPersistence } = await import(
      "./adapters/drizzle-change-trails.js"
    );
    const { createDrizzleBranchStore } = await import("./adapters/drizzle-branches.js");
    const { createDrizzleCollabPersistence } = await import("./adapters/drizzle-journal.js");
    const { createHocuspocusCoordinator } = await import("./adapters/hocuspocus-coordinator.js");
    const { createFacade } = await import("./composition.js");
    const { createBranchConcurrentJournalWatermarks } = await import(
      "./domain/branch-agent-edit.js"
    );
    const { createBranchCoordinator } = await import("./domain/branch-coordinator.js");
    const { createBranchPullService } = await import("./domain/branch-pulls.js");
    const { createBranchPushService } = await import("./domain/branch-push.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const documentSchema = buildDocumentSchema();
    const markupCodec = mdxCodec({ schema: documentSchema });
    const model = yProsemirrorModel(documentSchema);

    const USER_ID = "00000000-0000-4000-8000-000000000801";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000802";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000803";
    const WORK_ID = "00000000-0000-4000-8000-000000000804" as WorkId;
    const ALPHA_ID = "00000000-0000-4000-8000-000000000805" as DocumentId;
    const BETA_ID = "00000000-0000-4000-8000-000000000806" as DocumentId;
    const THREAD_ID = "00000000-0000-4000-8000-000000000807" as ThreadId;
    const TURN_ID = "00000000-0000-4000-8000-000000000808" as TurnId;

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        schema.turnTrailWork,
        schema.changeTrailDeliveryOutbox,
        schema.changeTrailDocumentDetails,
        schema.changeTrailShells,
        schema.pendingNoticeDeliveries,
        schema.pendingNotices,
        schema.agentEditMutations,
        schema.branchWriteJournal,
        schema.pushLineage,
        schema.documentBranches,
        schema.documentYjsCheckpoints,
        schema.documentYjsHeads,
        schema.documentYjsUpdates,
        schema.threadWorks,
        schema.turns,
        schema.threads,
        schema.folders,
        schema.documents,
        schema.contextSources,
        schema.works,
        schema.projects,
        schema.users,
      ]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "response-atomicity"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Atomicity",
        slug: "atomicity",
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Atomicity work",
        aiWriteMode: "draft",
      });
      await db.insert(schema.contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(schema.documents).values([
        {
          id: ALPHA_ID,
          contextSourceId: SOURCE_ID,
          name: "alpha",
          extension: "md",
          fileType: "markdown",
        },
        {
          id: BETA_ID,
          contextSourceId: SOURCE_ID,
          name: "beta",
          extension: "md",
          fileType: "markdown",
        },
      ]);
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(schema.turns).values({
        id: TURN_ID,
        threadId: THREAD_ID,
        role: "assistant",
        status: "complete",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it("rolls back all ten state surfaces and commits the retained response on retry", async () => {
      const harness = createHarness();
      await harness.seedAndStage("retry-response");
      const before = await harness.captureState();
      const staged = harness.stagedUpdates("retry-response");
      expect(harness.pendingWatermarkDocuments()).toHaveLength(2);

      harness.failSecondJournalInsert = true;
      await expect(harness.commit("retry-response")).rejects.toThrow(
        "injected second-document journal failure",
      );

      // Amendment-2 §F's ten rollback surfaces, kept explicit so a regression names its leak.
      expect(await harness.responseJournalRows()).toEqual([]); // 1. Postgres journal
      expect(await harness.databaseBranchHashes()).toEqual(before.databaseBranchHashes); // 2. snapshots
      expect(await harness.threadPeerMarkdown()).toEqual(before.threadPeerMarkdown); // 3. peer cache
      expect(await harness.workDraftMarkdown()).toEqual(before.workDraftMarkdown); // 4. draft cache
      expect(harness.stagedUpdates("retry-response").map((updates) => updates.length)).toEqual([
        1, 1,
      ]); // 5. facade still owns the response
      expect(harness.stagedUpdates("retry-response")).toEqual(staged); // 6. raw staged updates retained
      expect(harness.pendingWatermarkDocuments()).toEqual([]); // 7. pending watermarks cleared
      expect(harness.responseEvents("retry-response")).not.toContainEqual(
        expect.objectContaining({ transition: "closed" }),
      ); // 8. lifecycle not closed (retained buffers prove buffered ownership)
      expect(harness.afterCommitEffects()).toEqual({
        autoPushSchedules: [],
        branchBroadcasts: [],
        watermarkCommits: [],
      }); // 9. callbacks not dispatched
      expect(harness.openRoomIds()).toEqual([ALPHA_ID, BETA_ID]);
      expect(harness.liveRoomBroadcasts()).toEqual([]);
      // 10. No notices persisted; this scenario does not engage the producer. The
      // late-sweep ambient-rollback differential below verifies its transaction binding.
      expect(await harness.noticeRows()).toEqual([]);

      harness.failSecondJournalInsert = false;
      await expect(harness.commit("retry-response")).resolves.toMatchObject({
        status: "committed",
        documents: expect.arrayContaining([
          expect.objectContaining({ documentId: ALPHA_ID }),
          expect.objectContaining({ documentId: BETA_ID }),
        ]),
      });
      await harness.expectSuccessfulCommit("retry-response");
    });

    it("commits two documents and publishes process-local state after Postgres commits", async () => {
      const harness = createHarness();
      await harness.seedAndStage("positive-response");

      await expect(harness.commit("positive-response")).resolves.toMatchObject({
        status: "committed",
      });
      await harness.expectSuccessfulCommit("positive-response");
    });

    it("aborts every response participant when an outer ambient transaction rolls back later", async () => {
      const harness = createHarness();
      await harness.seedAndStage("outer-rollback-response");
      const before = await harness.captureState();
      expect(harness.pendingWatermarkDocuments()).toHaveLength(2);

      await expect(
        runInDrizzleTransaction(db, async () => {
          await harness.commit("outer-rollback-response");
          throw new Error("later outer failure");
        }),
      ).rejects.toThrow("later outer failure");

      expect(await harness.responseJournalRows()).toEqual([]);
      expect(await harness.databaseBranchHashes()).toEqual(before.databaseBranchHashes);
      expect(await harness.threadPeerMarkdown()).toEqual(before.threadPeerMarkdown);
      expect(await harness.workDraftMarkdown()).toEqual(before.workDraftMarkdown);
      expect(harness.stagedUpdates("outer-rollback-response").map((rows) => rows.length)).toEqual([
        1, 1,
      ]);
      expect(harness.pendingWatermarkDocuments()).toEqual([]);
      expect(harness.responseEvents("outer-rollback-response")).not.toContainEqual(
        expect.objectContaining({ transition: "closed" }),
      );
      expect(harness.afterCommitEffects()).toEqual({
        autoPushSchedules: [],
        branchBroadcasts: [],
        watermarkCommits: [],
      });
    });

    it("rolls back an attempted late-sweep notice with its ambient transaction, then persists it on commit", async () => {
      const harness = createHarness();
      const responseId = "late-sweep-notice-response";
      await harness.seedAndStageDestructive(responseId);

      await expect(
        runInDrizzleTransaction(db, async () => {
          await expect(harness.commit(responseId)).resolves.toMatchObject({
            status: "committed",
            documents: [
              expect.objectContaining({
                documentId: ALPHA_ID,
                lateSweep: expect.objectContaining({ affectedBlockHashes: expect.any(Array) }),
              }),
            ],
          });
          throw new Error("failure after late-sweep notice recording");
        }),
      ).rejects.toThrow("failure after late-sweep notice recording");

      expect(harness.noticeRecordAttempts()).toBeGreaterThan(0);
      expect(await harness.noticeRows()).toEqual([]);

      const commitHarness = createHarness();
      const commitResponseId = "late-sweep-notice-commit-response";
      await commitHarness.seedAndStageDestructive(commitResponseId, BETA_ID);
      await expect(commitHarness.commit(commitResponseId)).resolves.toMatchObject({
        status: "committed",
        documents: [expect.objectContaining({ lateSweep: expect.any(Object) })],
      });
      expect(await commitHarness.noticeRows()).toEqual([
        expect.objectContaining({ kind: "late_sweep", scopeKind: "thread", scopeId: THREAD_ID }),
      ]);
    });

    it("atomically persists an auto-push sweep trail and rolls the push back when trail recording fails", async () => {
      const success = createHarness();
      const successBranchId = await success.seedDestructivePush("push-swept-success");
      const beforeSuccess = await success.liveMarkdown(ALPHA_ID);
      await expect(success.autoPush(successBranchId)).resolves.toMatchObject({
        status: "pushed",
        swept: { reversible: false },
      });
      expect(await success.liveMarkdown(ALPHA_ID)).not.toEqual(beforeSuccess);
      expect(await success.noticeRows()).toEqual([
        expect.objectContaining({
          kind: "push_swept",
          data: expect.objectContaining({
            documentName: "alpha",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            reversible: false,
            capturedDeletedBodies: [
              expect.objectContaining({ body: expect.stringContaining("Writer captured body") }),
            ],
          }),
        }),
      ]);
      expect(await success.trailRows()).toMatchObject({
        shells: [{}],
        details: [{}],
        outbox: [{}],
      });

      await truncateDrizzleTables(db, [
        schema.pendingNoticeDeliveries,
        schema.pendingNotices,
        schema.changeTrailDeliveryOutbox,
        schema.changeTrailDocumentDetails,
        schema.changeTrailShells,
        schema.agentEditMutations,
        schema.branchWriteJournal,
        schema.pushLineage,
        schema.documentBranches,
        schema.documentYjsCheckpoints,
        schema.documentYjsHeads,
        schema.documentYjsUpdates,
      ]);
      const failed = createHarness();
      const failedBranchId = await failed.seedDestructivePush("push-swept-failure");
      const beforeFailure = await failed.liveMarkdown(ALPHA_ID);
      failed.failNoticeRecording = true;
      await expect(failed.autoPush(failedBranchId)).rejects.toThrow("injected notice failure");
      expect(await failed.liveMarkdown(ALPHA_ID)).toEqual(beforeFailure);
      expect(await failed.pushRows()).toEqual([]);
      expect(await failed.noticeRows()).toEqual([]);
      expect(await failed.trailRows()).toEqual({ shells: [], details: [], outbox: [] });
    });

    it("rolls content, lineage, shell, detail, and outbox back at every trail insert boundary", async () => {
      const harness = createHarness();
      const branchId = await harness.seedDestructivePush("trail-insert-boundaries");
      const beforeMarkdown = await harness.liveMarkdown(ALPHA_ID);
      const beforeUpdates = await harness.liveUpdateCount();

      for (const table of [
        "change_trail_shells",
        "change_trail_document_details",
        "change_trail_delivery_outbox",
      ]) {
        await db.execute(
          sql.raw(`
          CREATE OR REPLACE FUNCTION inject_change_trail_failure() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ${table} failure'; END $$;
          CREATE TRIGGER inject_change_trail_failure
          BEFORE INSERT ON ${table}
          FOR EACH ROW EXECUTE FUNCTION inject_change_trail_failure();
        `),
        );
        try {
          await expect(harness.autoPush(branchId)).rejects.toThrow();
        } finally {
          await db.execute(sql.raw(`DROP TRIGGER inject_change_trail_failure ON ${table}`));
        }
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe(beforeMarkdown);
        expect(await harness.liveUpdateCount()).toBe(beforeUpdates);
        expect(await harness.pushRows()).toEqual([]);
        expect(await harness.trailRows()).toEqual({ shells: [], details: [], outbox: [] });
        expect(await harness.noticeRows()).toEqual([]);
        expect(await harness.activePushJournalCount()).toBe(1);
      }
      await db.execute(sql.raw("DROP FUNCTION inject_change_trail_failure()"));
    });

    it("commits normalized trail state once and reuses it on an already-pushed retry", async () => {
      const harness = createHarness();
      const branchId = await harness.seedDestructivePush("trail-commit-retry");
      await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
      const committed = await harness.trailRows();
      expect(committed.shells).toHaveLength(1);
      expect(committed.details).toHaveLength(1);
      expect(committed.outbox).toHaveLength(1);
      const changes = (committed.details[0]?.changes ?? []) as Array<{ swept: unknown }>;
      expect(committed.shells[0]).toMatchObject({
        changeCount: changes.length,
        sweptChangeCount: changes.filter((change) => change.swept).length,
        documentCount: 1,
      });

      await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "already_pushed" });
      expect(await harness.trailRows()).toEqual(committed);
    });

    it("keeps a mixed-owner push shared and preserves its shell across document deletion", async () => {
      const harness = createHarness();
      const branchId = await harness.seedDestructivePush("trail-shared-delete");
      await harness.makeJournalOwnershipMixed();
      await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
      const beforeDelete = await harness.trailRows();
      expect(beforeDelete.shells).toEqual([
        expect.objectContaining({ ownerKind: "shared", turnId: null, changeCount: 1 }),
      ]);
      expect(await harness.pushRows()).toEqual([expect.objectContaining({ turnId: null })]);

      await harness.hardDeleteDocument(ALPHA_ID);
      const afterDocumentDelete = await harness.trailRows();
      expect(afterDocumentDelete.shells).toEqual(beforeDelete.shells);
      expect(afterDocumentDelete.details).toEqual([]);
      expect(afterDocumentDelete.outbox).toEqual(beforeDelete.outbox);

      await harness.hardDeleteThread();
      expect(await harness.trailRows()).toEqual({ shells: [], details: [], outbox: [] });
    });

    it("settles manual-policy turn work through a durable no-op", async () => {
      const harness = createHarness();
      await harness.seedDestructivePush("manual-policy-settlement");

      await harness.pollTrails();
      expect(await harness.workRows()).toEqual([
        expect.objectContaining({ state: "no_op", attempts: 0 }),
      ]);
      expect(await harness.trailRows()).toMatchObject({
        shells: [expect.objectContaining({ state: "settling", version: 2 })],
        details: [],
        outbox: [expect.objectContaining({ eventKind: "updated", version: 2 })],
      });

      await harness.pollTrails();
      expect(await harness.trailRows()).toMatchObject({
        shells: [
          expect.objectContaining({
            state: "settled",
            version: 3,
            changeCount: 0,
            sweptChangeCount: 0,
            documentCount: 0,
            settledAt: expect.any(Date),
          }),
        ],
        details: [],
        outbox: [
          expect.objectContaining({ eventKind: "updated", version: 2 }),
          expect.objectContaining({ eventKind: "updated", version: 3 }),
          expect.objectContaining({ eventKind: "settled", version: 3 }),
        ],
      });
    });

    function createHarness() {
      const persistence = createDrizzleCollabPersistence(db);
      const hocuspocus = fakeHocuspocus();
      const liveCoordinator = createHocuspocusCoordinator({
        hocuspocus: () => hocuspocus as never,
        journal: persistence.journal,
      });
      const realBranchStore = createDrizzleBranchStore(db, {
        journal: persistence.journal,
        lifecycle: persistence.lifecycle,
        coordinator: liveCoordinator,
      });
      let journalInsertCount = 0;
      const state = { failSecondJournalInsert: false };
      function injectSecondJournalFailure(): void {
        if (++journalInsertCount === 2 && state.failSecondJournalInsert) {
          throw new Error("injected second-document journal failure");
        }
      }
      const branchStore = {
        ...realBranchStore,
        async appendJournal(
          input: Parameters<NonNullable<typeof realBranchStore.appendJournal>>[0],
        ) {
          injectSecondJournalFailure();
          return realBranchStore.appendJournal?.(input);
        },
        async commitBranchMutation(
          input: Parameters<NonNullable<typeof realBranchStore.commitBranchMutation>>[0],
        ) {
          if (input.journal) injectSecondJournalFailure();
          return realBranchStore.commitBranchMutation?.(input) ?? false;
        },
      };
      const branchBroadcasts: string[] = [];
      const branchCoordinator = createBranchCoordinator({
        store: branchStore,
        onBranchUpdate: ({ branchId }) => branchBroadcasts.push(branchId),
      });
      const phaseCInjection: { accesses: number; run: (() => Promise<void>) | null } = {
        accesses: 0,
        run: null,
      };
      const facadeBranchCoordinator = {
        ...branchCoordinator,
        async withBranchTransient<T>(
          branchId: string,
          operation: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
        ) {
          // A response commit opens the branch once for preflight and again for phase C.
          // Injecting on the second access creates the narrow post-preflight sweep window.
          if (phaseCInjection.run && ++phaseCInjection.accesses === 2) {
            const inject = phaseCInjection.run;
            phaseCInjection.run = null;
            await inject();
          }
          return branchCoordinator.withBranchTransient(branchId, operation);
        },
      };
      const realWatermarks = createBranchConcurrentJournalWatermarks();
      const pendingWatermarks = new Set<string>();
      const watermarkCommits: string[] = [];
      const watermarkKey = (threadId: ThreadId, documentId: DocumentId) =>
        `${threadId}:${documentId}`;
      const watermarks = {
        current: realWatermarks.current,
        capturePending(threadId: ThreadId, documentId: DocumentId, id: number, attemptId?: string) {
          pendingWatermarks.add(watermarkKey(threadId, documentId));
          realWatermarks.capturePending(threadId, documentId, id, attemptId);
        },
        commitPending(threadId: ThreadId, documentId: DocumentId, attemptId?: string) {
          pendingWatermarks.delete(watermarkKey(threadId, documentId));
          watermarkCommits.push(watermarkKey(threadId, documentId));
          realWatermarks.commitPending(threadId, documentId, attemptId);
        },
        clearPending(threadId: ThreadId, documentId: DocumentId) {
          pendingWatermarks.delete(watermarkKey(threadId, documentId));
          realWatermarks.clearPending(threadId, documentId);
        },
      };
      const branchPulls = createBranchPullService({
        liveCoordinator,
        branchCoordinator,
        branches: branchStore,
        concurrentJournalWatermarks: watermarks,
      });
      const branchPushStore = createDrizzleBranchPushStore(db, { model, codec: markupCodec });
      const changeTrails = createDrizzleChangeTrailPersistence(db);
      const realNotices = createDrizzleNoticePort(
        db,
        createActiveDocumentResolver(createDrizzleRepositories(db)),
      );
      const noticeState = { fail: false };
      let noticeRecordAttempts = 0;
      const notices = {
        ...realNotices,
        async record(input: Parameters<typeof realNotices.record>[0]) {
          noticeRecordAttempts += 1;
          if (noticeState.fail) throw new Error("injected notice failure");
          return realNotices.record(input);
        },
      };
      const realBranchPush = createBranchPushService({
        branchStore,
        pushStore: branchPushStore,
        branchCoordinator,
        journal: persistence.journal,
        liveCoordinator,
        model,
        codec: markupCodec,
        notices,
        changeTrails,
        resolveDocumentTitle: async (documentId) => (documentId === ALPHA_ID ? "alpha" : "beta"),
      });
      const deliveredEvents: unknown[] = [];
      const fences: Array<{ threadId: string; documentId: string }> = [];
      const trailDelivery = createChangeTrailDeliveryDispatcher({
        db,
        journalWriter: {
          async appendEvent(_threadId: string, event: unknown) {
            deliveredEvents.push(event);
            return deliveredEvents.length;
          },
        } as never,
        eventHub: { publishPersistedEvent() {} },
        retryBranch: (branchId) => realBranchPush.pushToLive({ branchId }),
        onRetryExhausted: (threadId, documentId) => fences.push({ threadId, documentId }),
      });
      const autoPushSchedules: string[] = [];
      const branchPush = {
        ...realBranchPush,
        async pushAutoBranchAfterThreadPeerWrite(input: { workDraftBranchId: string }) {
          autoPushSchedules.push(input.workDraftBranchId);
          return realBranchPush.pushAutoBranchAfterThreadPeerWrite(input);
        },
      };
      const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
      let preCommitBranchHashes: Array<{ id: string; state: string; stateVector: string }> = [];
      const collab = createFacade({
        ...persistence,
        coordinator: liveCoordinator,
        hocuspocus: () => hocuspocus as never,
        bindHocuspocus() {},
        liveLineage: {
          listLiveDocumentsForTurn: async () => [],
          listEditedDocumentsForTurn: async () => [],
          getTurnReceiptChip: async () => null,
          getTurnChangeDiff: async () => null,
        } as never,
        threads: { findById: async () => ({ id: THREAD_ID }) },
        notices,
        eventSink: {
          emit(event) {
            events.push({ name: event.name, payload: event.payload });
          },
          emitBatch(batch) {
            for (const event of batch) events.push({ name: event.name, payload: event.payload });
          },
          flush: async () => {},
        },
        branchStore,
        branchCoordinator: facadeBranchCoordinator,
        branchPulls,
        branchPush,
        branchPushStore,
        concurrentJournalWatermarks: watermarks,
        documentUriResolver: async (documentId) =>
          documentId === ALPHA_ID ? "manuscript/alpha.md" : "manuscript/beta.md",
        resolveWorkWriteMode: async () => "draft",
        commitThreadResponseAtomically: (operation) => runInDrizzleTransaction(db, operation),
      });

      async function seedAndStage(responseId: string) {
        await collab.writeDocument({
          documentId: ALPHA_ID,
          markdown: "Alpha base.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID,
        });
        await collab.writeDocument({
          documentId: BETA_ID,
          markdown: "Beta base.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID,
        });
        const context = {
          sessionId: THREAD_ID,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId,
        };
        // Establish thread peers first, then append a real concurrent work-draft row.
        // The following staged write must capture that row as a pending watermark.
        await collab
          .agentEdit()
          .write(
            { command: "read", file: "alpha.md", documentId: ALPHA_ID },
            { ...context, responseId: undefined },
          );
        await collab
          .agentEdit()
          .write(
            { command: "read", file: "beta.md", documentId: BETA_ID },
            { ...context, responseId: undefined },
          );
        for (const documentId of [ALPHA_ID, BETA_ID]) {
          const draft = await branchStore.resolveWorkDraftBranchForThread(documentId, THREAD_ID);
          const last = model.getBlocks(toDocHandle(draft.doc)).at(-1) ?? null;
          model.insertBlocks(toDocHandle(draft.doc), last, markupCodec.parse("Writer concurrent."));
          await branchCoordinator.commitSyncFromDoc({
            branchId: draft.branchId,
            sourceDoc: draft.doc,
            expectedGeneration: draft.generation,
            source: "writer",
            actorUserId: USER_ID as never,
            threadId: THREAD_ID,
            turnId: null,
            wId: null,
            updateMeta: null,
          });
          draft.doc.destroy();
        }
        branchBroadcasts.length = 0;
        watermarkCommits.length = 0;
        autoPushSchedules.length = 0;
        hocuspocus.broadcasts.length = 0;
        await expect(
          collab.agentEdit().write(
            {
              command: "insert",
              file: "alpha.md",
              documentId: ALPHA_ID,
              content: "Agent alpha.",
            },
            context,
          ),
        ).resolves.toMatchObject({ status: "success", phase: "staged" });
        await expect(
          collab
            .agentEdit()
            .write(
              { command: "insert", file: "beta.md", documentId: BETA_ID, content: "Agent beta." },
              context,
            ),
        ).resolves.toMatchObject({ status: "success", phase: "staged" });
        preCommitBranchHashes = await databaseBranchHashes();
      }

      async function seedAndStageDestructive(
        responseId: string,
        documentId: DocumentId = ALPHA_ID,
      ) {
        const file = documentId === ALPHA_ID ? "alpha.md" : "beta.md";
        await collab.writeDocument({
          documentId,
          markdown: "Alpha base.\n\nWriter block.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID,
        });
        const context = {
          sessionId: THREAD_ID,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId,
          createdDocument: false,
        };
        await collab
          .agentEdit()
          .write({ command: "read", file, documentId }, { ...context, responseId: undefined });
        await expect(
          collab.agentEdit().write(
            {
              command: "create",
              file,
              documentId,
              content: "# Agent replacement",
              overwrite: true,
            },
            context,
          ),
        ).resolves.toMatchObject({ status: "success", phase: "staged" });

        phaseCInjection.accesses = 0;
        phaseCInjection.run = () =>
          runInRootDrizzleTransaction(db, async () => {
            const draft = await branchStore.resolveWorkDraftBranchForThread(documentId, THREAD_ID);
            try {
              const writerBlock = model.getBlocks(toDocHandle(draft.doc))[1];
              if (!writerBlock) throw new Error("writer block missing before concurrent edit");
              draft.doc.transact(
                () =>
                  model.applyTextEdit(
                    toDocHandle(draft.doc),
                    writerBlock,
                    { from: 0, to: 0 },
                    "Writer concurrent edit: ",
                  ),
                { type: "human" },
              );
              const committed = await branchCoordinator.commitSyncFromDoc({
                branchId: draft.branchId,
                sourceDoc: draft.doc,
                expectedGeneration: draft.generation,
                source: "writer",
                actorUserId: USER_ID as never,
                threadId: THREAD_ID,
                turnId: null,
                wId: null,
                updateMeta: null,
              });
              if (!committed) throw new Error("concurrent writer edit did not commit");
            } finally {
              draft.doc.destroy();
            }
            await branchPulls.pullThreadPeer({ documentId, threadId: THREAD_ID });
          });
      }

      async function seedDestructivePush(responseId: string): Promise<string> {
        await collab.writeDocument({
          documentId: ALPHA_ID,
          markdown: "Writer captured body.\n\nSurvivor.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID,
        });
        const context = { sessionId: THREAD_ID, threadId: THREAD_ID, turnId: TURN_ID, responseId };
        await collab
          .agentEdit()
          .write(
            { command: "read", file: "alpha.md", documentId: ALPHA_ID },
            { ...context, responseId: undefined },
          );
        const branch = await branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
        const doomed = model.getBlocks(toDocHandle(branch.doc))[0];
        if (!doomed) throw new Error("draft block missing before destructive push");
        model.deleteBlock(toDocHandle(branch.doc), doomed);
        const committed = await branchCoordinator.commitSyncFromDoc({
          branchId: branch.branchId,
          sourceDoc: branch.doc,
          expectedGeneration: branch.generation,
          source: "agent",
          actorUserId: null,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          wId: null,
          updateMeta: null,
        });
        branch.doc.destroy();
        if (!committed) throw new Error("destructive draft edit did not commit");
        await liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
          const block = model.getBlocks(toDocHandle(doc))[0];
          if (!block) throw new Error("live writer block missing");
          const before = Y.encodeStateVector(doc);
          model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 0 }, "Writer recent: ");
          await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
            origin: `human:${USER_ID}`,
            seq: 0,
          });
        });
        return branch.branchId;
      }

      async function branchesByKind(kind: "thread_peer" | "work_draft") {
        return db
          .select()
          .from(schema.documentBranches)
          .where(eq(schema.documentBranches.kind, kind));
      }

      async function markdownByKind(kind: "thread_peer" | "work_draft") {
        const rows = await branchesByKind(kind);
        return Promise.all(
          rows
            .sort((left, right) => left.documentId.localeCompare(right.documentId))
            .map((row) =>
              branchCoordinator.readBranch(row.id, async (doc) => serializeMarkdown(doc)),
            ),
        );
      }

      return {
        get failSecondJournalInsert() {
          return state.failSecondJournalInsert;
        },
        set failSecondJournalInsert(value: boolean) {
          state.failSecondJournalInsert = value;
          journalInsertCount = 0;
        },
        seedAndStage,
        seedAndStageDestructive,
        noticeRecordAttempts: () => noticeRecordAttempts,
        set failNoticeRecording(value: boolean) {
          noticeState.fail = value;
        },
        seedDestructivePush,
        pollTrails: () => trailDelivery.drain(),
        workRows: () => db.select().from(schema.turnTrailWork),
        setPushPolicy: (pushPolicy: "auto" | "manual") =>
          db.update(schema.documentBranches).set({ pushPolicy }),
        autoPush: (branchId: string) =>
          realBranchPush.pushToLive({ branchId, overlapPolicy: "apply_and_trail" }),
        liveMarkdown: (documentId: DocumentId) =>
          liveCoordinator.withDocument(documentId, async (doc) => serializeMarkdown(doc)),
        pushRows: () => db.select().from(schema.pushLineage),
        liveUpdateCount: async () => (await db.select().from(schema.documentYjsUpdates)).length,
        activePushJournalCount: async () =>
          (
            await db
              .select()
              .from(schema.branchWriteJournal)
              .where(eq(schema.branchWriteJournal.status, "active"))
          ).length,
        async makeJournalOwnershipMixed() {
          const [owned] = await db
            .select()
            .from(schema.branchWriteJournal)
            .where(eq(schema.branchWriteJournal.status, "active"));
          if (!owned) throw new Error("missing owned journal row");
          await db.insert(schema.branchWriteJournal).values({
            branchId: owned.branchId,
            generation: owned.generation,
            wId: owned.wId,
            source: owned.source,
            threadId: owned.threadId,
            turnId: null,
            actorUserId: owned.actorUserId,
            updateData: owned.updateData,
            updateMeta: owned.updateMeta,
          });
        },
        hardDeleteDocument: (documentId: DocumentId) =>
          db.delete(schema.documents).where(eq(schema.documents.id, documentId)),
        async hardDeleteThread() {
          await db.delete(schema.turns).where(eq(schema.turns.threadId, THREAD_ID));
          await db.delete(schema.threads).where(eq(schema.threads.id, THREAD_ID));
        },
        commit: (responseId: string) =>
          collab.finalizeResponseCommit(responseId, { threadId: THREAD_ID, turnId: TURN_ID }),
        afterCommitEffects: () => ({
          autoPushSchedules: [...autoPushSchedules].sort(),
          branchBroadcasts: [...branchBroadcasts].sort(),
          watermarkCommits: [...watermarkCommits].sort(),
        }),
        openRoomIds: () => [...hocuspocus.documents.keys()].sort(),
        liveRoomBroadcasts: () => [...hocuspocus.broadcasts],
        stagedUpdates: (responseId: string) => [
          [...collab.agentEdit().bufferedUpdatesForDoc(responseId, ALPHA_ID)],
          [...collab.agentEdit().bufferedUpdatesForDoc(responseId, BETA_ID)],
        ],
        pendingWatermarkDocuments: () => [...pendingWatermarks].sort(),
        responseEvents: (responseId: string) =>
          events
            .filter((event) => event.payload.responseId === responseId)
            .map((event) => ({
              transition: event.name.replace("response_committer.", ""),
              phase: event.payload.phase,
            })),
        responseJournalRows: () =>
          db
            .select()
            .from(schema.branchWriteJournal)
            .where(
              and(
                eq(schema.branchWriteJournal.threadId, THREAD_ID),
                eq(schema.branchWriteJournal.turnId, TURN_ID),
              ),
            ),
        noticeRows: () => db.select().from(schema.pendingNotices),
        async trailRows() {
          return {
            shells: await db.select().from(schema.changeTrailShells),
            details: await db.select().from(schema.changeTrailDocumentDetails),
            outbox: await db.select().from(schema.changeTrailDeliveryOutbox),
          };
        },
        threadPeerMarkdown: () => markdownByKind("thread_peer"),
        workDraftMarkdown: () => markdownByKind("work_draft"),
        async databaseBranchHashes() {
          return databaseBranchHashes();
        },
        async captureState() {
          return {
            databaseBranchHashes: await this.databaseBranchHashes(),
            threadPeerMarkdown: await this.threadPeerMarkdown(),
            workDraftMarkdown: await this.workDraftMarkdown(),
          };
        },
        async expectSuccessfulCommit(responseId: string) {
          expect(await this.responseJournalRows()).toHaveLength(2);
          expect(await databaseBranchHashes()).not.toEqual(preCommitBranchHashes);
          expect(await this.threadPeerMarkdown()).toEqual([
            expect.stringContaining("Agent alpha."),
            expect.stringContaining("Agent beta."),
          ]);
          expect(await this.workDraftMarkdown()).toEqual([
            expect.stringContaining("Agent alpha."),
            expect.stringContaining("Agent beta."),
          ]);
          expect(this.stagedUpdates(responseId)).toEqual([[], []]);
          expect(this.responseEvents(responseId)).toContainEqual({
            transition: "closed",
            phase: "closed",
          });
          expect(branchBroadcasts).toHaveLength(2);
          expect(autoPushSchedules).toHaveLength(2);
          expect(watermarkCommits).toHaveLength(2);
          expect(this.openRoomIds()).toEqual([ALPHA_ID, BETA_ID]);
        },
      };

      async function databaseBranchHashes() {
        const rows = await db.select().from(schema.documentBranches);
        return rows
          .map((row) => ({
            id: row.id,
            state: Buffer.from(row.state).toString("base64"),
            stateVector: Buffer.from(row.stateVector).toString("base64"),
          }))
          .sort((left, right) => left.id.localeCompare(right.id));
      }
    }

    function serializeMarkdown(doc: Y.Doc): string {
      const blocks = model.getBlocks(toDocHandle(doc));
      return blocks.length === 0
        ? ""
        : markupCodec.serialize(model.projectBlocks(toDocHandle(doc)));
    }

    function fakeHocuspocus() {
      const documents = new Map<string, Y.Doc>();
      const broadcasts: string[] = [];
      return {
        documents,
        broadcasts,
        async openDirectConnection(documentName: string) {
          let document = documents.get(documentName);
          if (!document) {
            document = new Y.Doc({ gc: false });
            document.on("update", () => broadcasts.push(documentName));
            documents.set(documentName, document);
          }
          return { document, disconnect: async () => undefined };
        },
      };
    }
  });
}
