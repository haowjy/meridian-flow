/** Real-Postgres coverage for response-wide durability and process-local rollback. */
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

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
    const { runInDrizzleTransaction } = await import("../../shared/drizzle-transaction.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createDrizzleBranchPushStore } = await import("./adapters/drizzle-branch-push.js");
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
      expect(harness.afterCommitPublications).toEqual([]); // 9. callbacks not dispatched
      expect(await harness.noticeRows()).toEqual([]); // 10. notices rolled back

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
      const afterCommitPublications: string[] = [];
      const branchCoordinator = createBranchCoordinator({
        store: branchStore,
        onBranchUpdate: ({ branchId }) => afterCommitPublications.push(branchId),
      });
      const realWatermarks = createBranchConcurrentJournalWatermarks();
      const pendingWatermarks = new Set<string>();
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
      const branchPush = createBranchPushService({
        branchStore,
        pushStore: branchPushStore,
        branchCoordinator,
        journal: persistence.journal,
        liveCoordinator,
        model,
        codec: markupCodec,
      });
      const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
      const notices = createDrizzleNoticePort(db);
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
        branchCoordinator,
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
          if (!value) journalInsertCount = 0;
        },
        afterCommitPublications,
        seedAndStage,
        commit: (responseId: string) => collab.agentEdit().commitResponse(responseId),
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
          expect(afterCommitPublications).toHaveLength(2);
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
      return {
        documents,
        async openDirectConnection(documentName: string) {
          let document = documents.get(documentName);
          if (!document) {
            document = new Y.Doc({ gc: false });
            documents.set(documentName, document);
          }
          return { document, disconnect: async () => undefined };
        },
      };
    }
  });
}
