/** Adapter-contract tests for Drizzle draft peers against local Postgres. */

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTestWorkProjectionMutation } from "../../../../test-support/work-projection.js";
import {
  commitJournaledUpdate,
  resetDraftFromDoc,
} from "../../test-support/draft-update-writes.js";
import { createDrizzleDocumentDerivationStore } from "../drizzle-document-derivations.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle draft store (postgres)", () => {});
} else {
  describe("drizzle draft store adapter contract (postgres)", async () => {
    const dbSchema = await import("@meridian/database/schema");
    const {
      draftWriteJournal,
      contextSources,
      documentDrafts,
      documentYjsCheckpoints,
      documentYjsHeads,
      documents,
      branchCommands,
      branches,
      projects,
      pushLineage,
      threadWorks,
      threads,
      turns,
      users,
      works,
    } = dbSchema;
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../../../../test-support/drizzle-reset.js"
    );
    const { createDrizzleDraftStore } = await import("../drizzle-drafts.js");
    const { appendDraftRows, proseDraftUpdate, readDraftContent, readResolvedDraft } = await import(
      "../../test-support/draft-store-seam.js"
    );
    const { createDrizzleBranchStore } = await import("../drizzle-branches.js");
    const { createHocuspocusPersistenceService } = await import("../../hocuspocus-persistence.js");
    const {
      createDrizzleDraftJournalReadStore,
      createDrizzlePushCommitStore,
      createDrizzleWorkBranchPendingStore,
    } = await import("../drizzle-branch-push.js");
    const { createDrizzlePendingSettlementStore, stageSettlementBatchWithinTx } = await import(
      "../drizzle-pending-settlement.js"
    );
    const { createDrizzleChangeTrailAggregateWriter } = await import(
      "../drizzle-change-trail-aggregate.js"
    );
    const { createDrizzleDocumentProjectionEffects } = await import(
      "../drizzle-document-activity.js"
    );
    const { createDrizzleCollabPersistence } = await import("../drizzle-journal.js");
    const { createDraftCoordinator } = await import("../../domain/draft-coordinator.js");
    const { mdxCodec, UNSCOPED_DOCUMENT_LINKS } = await import("@meridian/markup");
    const { toDocHandle, yProsemirrorModel } = await import("@meridian/agent-edit/integration");
    const { createDocumentLastAddress } = await import("../../../context/document-uri-resolver.js");
    const { COLLAB_SCHEMA_VERSION, packCollabSchemaVersion } = await import(
      "@meridian/prosemirror-schema"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000601";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000602";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000603";
    const WORK_ID = "00000000-0000-4000-8000-000000000604";
    const NEXT_WORK_ID = "00000000-0000-4000-8000-000000000608";
    const BRANCH_ID = "00000000-0000-4000-8000-000000000609";
    const NEXT_BRANCH_ID = "00000000-0000-4000-8000-000000000610";
    const DOC_ID = "00000000-0000-4000-8000-000000000605";
    const THREAD_ID = "00000000-0000-4000-8000-000000000606";
    const TURN_ID = "00000000-0000-4000-8000-000000000607";

    const measuredQueries: string[] = [];
    let captureQueries = false;
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      postgres: {
        debug: (_connection, query) => {
          if (captureQueries) measuredQueries.push(query);
        },
      },
      prepareSuite: async (db) => {
        await deleteDrizzleRows(db, [users]);
        await db.insert(users).values(conformanceUserValues(USER_ID, "drizzle-drafts"));
        await db.insert(projects).values({
          id: PROJECT_ID,
          userId: USER_ID,
          name: "Draft Project",
          slug: "branch-project",
        });
        await db.insert(works).values({
          id: WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Draft Work",
          slug: "branch-work",
        });
        await db.insert(branches).values({
          id: BRANCH_ID,
          projectId: PROJECT_ID,
          originWorkId: WORK_ID,
          createdBy: USER_ID,
        });
        await db.insert(contextSources).values({
          id: SOURCE_ID,
          projectId: PROJECT_ID,
          name: "Manuscript",
          slug: "manuscript",
          scope: "project",
          isPrimary: true,
        });
        await db.insert(documents).values({
          id: DOC_ID,
          contextSourceId: SOURCE_ID,
          name: "chapter",
          extension: "",
          fileType: "markdown",
        });
        await db.insert(threads).values({
          rootThreadId: THREAD_ID,
          id: THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Thread",
          kind: "primary",
          status: "idle",
        });
        await db.insert(turns).values({
          id: TURN_ID as never,
          threadId: THREAD_ID as never,
          position: 1,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
        await db
          .insert(threadWorks)
          .values({ threadId: THREAD_ID, workId: WORK_ID, projectId: PROJECT_ID, isPrimary: true });
      },
    });
    let db = database.current;
    let livePersistence = createDrizzleCollabPersistence(db);
    function createDraftStore() {
      return createDrizzleDraftStore(db, {
        workProjection: createTestWorkProjectionMutation(db),
        live: {
          journal: livePersistence.journal,
          lifecycle: livePersistence.lifecycle,
        },
        branches: createDrizzleBranchStore(db),
      });
    }

    let store = createDraftStore();

    function draftRoomPersistence(draftStore = store) {
      return createHocuspocusPersistenceService({
        journal: livePersistence.journal,
        draftStore,
        draftCoordinator: createDraftCoordinator({
          onAppendCommitted: () => {},
          store: draftStore,
        }),
        hocuspocus: () => null,
        metaForOrigin: () => ({ origin: "system", seq: 0 }),
        emitAgentEditInvariantViolation: () => undefined,
      });
    }

    function docWithText(value: string): Y.Doc {
      const doc = new Y.Doc({ gc: false });
      doc.getText("content").insert(0, value);
      return doc;
    }

    const _markdownProjectionSerializer = (
      model: ReturnType<typeof yProsemirrorModel>,
      codec: ReturnType<typeof mdxCodec>,
    ) => ({
      async serializeDocument(_documentId: string, doc: Y.Doc) {
        return codec.serialize(model.projectBlocks(toDocHandle(doc)), UNSCOPED_DOCUMENT_LINKS);
      },
    });
    const _createPushStores = (
      serializer: Parameters<typeof createDrizzlePendingSettlementStore>[1],
      changeTrails: Parameters<
        typeof createDrizzlePushCommitStore
      >[2] = createDrizzleChangeTrailAggregateWriter(db),
    ) => {
      const journalReadStore = createDrizzleDraftJournalReadStore(db);
      const commitStore = createDrizzlePushCommitStore(
        db,
        stageSettlementBatchWithinTx,
        changeTrails,
        undefined,
        createTestWorkProjectionMutation(db),
      );
      return {
        journalReadStore,
        commitStore,
        workBranchPendingStore: createDrizzleWorkBranchPendingStore(db),
        settlementStore: createDrizzlePendingSettlementStore(
          db,
          serializer,
          createDrizzleDocumentProjectionEffects(db, createTestWorkProjectionMutation(db)),
          changeTrails,
          createDrizzleDocumentDerivationStore(db, createDocumentLastAddress(db)),
          undefined,
          undefined,
          { steps: [] },
          createTestWorkProjectionMutation(db),
        ),
      };
    };

    beforeEach(async () => {
      db = database.current;
      livePersistence = createDrizzleCollabPersistence(db);
      store = createDraftStore();
    });

    it("reseeds a clean thread peer under the reassigned primary Work's draft", async () => {
      const live = docWithText("live prose");
      const { documentDraft: oldPeer } = await store.ensureThreadPeerDraft({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: live,
      });
      await db.insert(works).values({
        id: NEXT_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Next Work",
        slug: "next-work",
      });
      await db.insert(branches).values({
        id: NEXT_BRANCH_ID,
        projectId: PROJECT_ID,
        originWorkId: NEXT_WORK_ID,
        createdBy: USER_ID,
      });
      await db.transaction(async (tx) => {
        await tx
          .update(threadWorks)
          .set({ isPrimary: false })
          .where(eq(threadWorks.threadId, THREAD_ID));
        await tx.insert(threadWorks).values({
          threadId: THREAD_ID,
          workId: NEXT_WORK_ID,
          projectId: PROJECT_ID,
          isPrimary: true,
        });
      });

      await expect(
        store.resolveThreadDraft(DOC_ID as never, THREAD_ID as never),
      ).rejects.toMatchObject({ name: "DraftNotFoundError" });
      const { documentDraft: nextPeer } = await store.ensureThreadPeerDraft({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        branchId: NEXT_BRANCH_ID as never,
        liveDoc: live,
      });
      const [oldRow, nextUpstream] = await Promise.all([
        db
          .select({ status: documentDrafts.status, revision: documentDrafts.revision })
          .from(documentDrafts)
          .where(eq(documentDrafts.id, oldPeer.draftId))
          .then((rows) => rows[0]),
        store.getDraft(nextPeer.upstreamDraftId ?? ""),
      ]);

      expect(nextPeer).toMatchObject({
        branchId: NEXT_BRANCH_ID,
        workId: NEXT_WORK_ID,
        threadId: THREAD_ID,
        status: "active",
      });
      expect(nextPeer.draftId).not.toBe(oldPeer.draftId);
      // A close moves the revision, so an exact rewrite computed before it misses.
      expect(oldRow).toMatchObject({ status: "closed", revision: oldPeer.revision + 1 });
      expect(nextUpstream?.workId).toBe(NEXT_WORK_ID);
    });

    it("bulk-appends forty segment rows with one journal insert and no pending scans", async () => {
      const { createWorkProjectionMutation } = await import(
        "../../../projects/adapters/work-projection-mutation.js"
      );
      const { createDrizzleContextCatalog } = await import(
        "../../../context/adapters/context-catalog.js"
      );
      const { createDrizzleProjectContextAvailability } = await import(
        "../../../context/adapters/project-context-availability.js"
      );
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      });
      const projection = createWorkProjectionMutation({
        db,
        pendingCounts: createDrizzleWorkBranchPendingStore(db),
        availability,
        catalog,
      });
      const measuredStore = createDrizzleDraftStore(db, {
        live: { journal: livePersistence.journal, lifecycle: livePersistence.lifecycle },
        workProjection: projection,
        branches: createDrizzleBranchStore(db),
      });
      const base = docWithText("live");
      const documentDraft = await measuredStore.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: base,
      });
      const snapshot = await measuredStore.getDraft(documentDraft.draftId);
      if (!snapshot) throw new Error("missing batch target");
      const source = new Y.Doc({ gc: false });
      Y.applyUpdate(source, await readDraftContent(measuredStore, documentDraft.draftId));
      const { createDrizzleJournal } = await import("../drizzle-journal.js");
      const wId = await createDrizzleJournal(db).reserveWriteOrdinal(DOC_ID, THREAD_ID);
      const rows = Array.from({ length: 40 }, (_, index) => {
        source.clientID = 10000 + index;
        const before = Y.encodeStateVector(source);
        source.getText("content").insert(source.getText("content").length, String(index));
        return {
          draftId: documentDraft.draftId,
          generation: snapshot.generation,
          source: "agent" as const,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          toolCallId: "forty-segment-edit",
          wId,
          updateData: Y.encodeStateAsUpdate(source, before),
        };
      });
      measuredQueries.length = 0;
      captureQueries = true;
      try {
        const coordinator = createDraftCoordinator({
          onAppendCommitted: () => {},
          store: measuredStore,
        });
        expect(
          await coordinator.commitSegmentRows({
            draftId: documentDraft.draftId,
            expectedGeneration: snapshot.generation,
            sourceDoc: source,
            rows,
          }),
        ).toBe(true);
      } finally {
        captureQueries = false;
      }
      // An append locks no Work and counts no pending drafts (#931).
      expect(
        measuredQueries.filter((query) =>
          query.startsWith('(select "branches"."origin_work_id", "document_drafts"."document_id"'),
        ),
      ).toHaveLength(0);
      expect(
        measuredQueries.filter((query) => query.startsWith('insert into "draft_write_journal"')),
      ).toHaveLength(1);
      const persisted = await db
        .select({ toolCallId: draftWriteJournal.toolCallId })
        .from(draftWriteJournal)
        .where(eq(draftWriteJournal.draftId, documentDraft.draftId))
        .orderBy(draftWriteJournal.id);
      expect(persisted.map((row) => row.toolCallId)).toEqual(rows.map((row) => row.toolCallId));
      source.destroy();
      base.destroy();
    });

    it("discard/reset marks old-generation rows discarded and unpushed counts join the active generation", async () => {
      // Pending counts describe visible manuscript effect, not arbitrary Y.Text roots.
      const { buildDocumentSchema, createCollabYDoc } = await import(
        "@meridian/prosemirror-schema"
      );
      const model = yProsemirrorModel(buildDocumentSchema());
      const codec = mdxCodec({ schema: buildDocumentSchema() });
      const proseDoc = (text: string) => {
        const doc = createCollabYDoc({ gc: false });
        model.insertBlocks(toDocHandle(doc), null, codec.parse(text));
        return doc;
      };
      const live = proseDoc("live base");
      const work = await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: live,
      });
      const resets: number[] = [];
      const coordinator = createDraftCoordinator({
        onAppendCommitted: () => {},
        store,
        onDraftReset: ({ generation }) => resets.push(generation),
      });
      const draft = proseDoc("draft row before discard");
      const seeded = await store.getDraft(work.draftId);
      const { createDrizzleJournal } = await import("../drizzle-journal.js");
      await commitJournaledUpdate(coordinator, {
        draftId: work.draftId,
        updateData: Y.encodeStateAsUpdate(draft),
        source: "agent",
        threadId: THREAD_ID as never,
        wId: await createDrizzleJournal(db).reserveWriteOrdinal(DOC_ID, THREAD_ID),
      });
      // The projection job's judgement of the append (design §3.2).
      const appended = await store.getDraft(work.draftId);
      if (!appended) throw new Error("the draft is gone");
      await expect(
        store.writeEffect({
          draftId: work.draftId,
          revision: appended.revision,
          hasEffect: true,
          workId: appended.workId,
        }),
      ).resolves.toBe("written");
      const pendingBranches = createDrizzleWorkBranchPendingStore(db);
      await expect(
        pendingBranches
          .countPendingByWorkIds([WORK_ID as never])
          .then((counts) => counts.get(WORK_ID as never) ?? 0),
      ).resolves.toBe(1);

      const { runInDrizzleTransaction } = await import("../../../../shared/drizzle-transaction.js");
      const before = await store.getDraft(work.draftId);
      // The append and the reset are review-membership inputs: each moves the revision (§2.5).
      expect(before?.revision).toBeGreaterThan(seeded?.revision ?? Number.POSITIVE_INFINITY);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await resetDraftFromDoc(coordinator, store, work.draftId, live);
          expect(resets).toEqual([]);
          throw new Error("abort composite discard");
        }),
      ).rejects.toThrow("abort composite discard");
      expect(await store.getDraft(work.draftId)).toEqual(before);
      expect(resets).toEqual([]);
      await resetDraftFromDoc(coordinator, store, work.draftId, live);
      expect(resets).toEqual([work.generation + 1]);
      expect((await store.getDraft(work.draftId))?.revision).toBeGreaterThan(
        before?.revision ?? Number.POSITIVE_INFINITY,
      );

      await expect(
        pendingBranches
          .countPendingByWorkIds([WORK_ID as never])
          .then((counts) => counts.get(WORK_ID as never) ?? 0),
      ).resolves.toBe(0);
      const rows = await db
        .select({ generation: draftWriteJournal.generation, status: draftWriteJournal.status })
        .from(draftWriteJournal)
        .where(eq(draftWriteJournal.draftId, work.draftId));
      expect(rows).toEqual([{ generation: work.generation, status: "discarded" }]);
    });

    it("keeps compacted live documents visible when seeding despite zero live update rows", async () => {
      const live = docWithText("compacted live chapter");
      const [checkpoint] = await db
        .insert(documentYjsCheckpoints)
        .values({
          documentId: DOC_ID as never,
          authorityId: DOC_ID as never,
          authorityGeneration: 1n,
          attributionManifest: { version: 1, floor: null, attributions: [] },
          state: Buffer.from(Y.encodeStateAsUpdate(live)),
          stateVector: Buffer.from(Y.encodeStateVector(live)),
          upToSeq: 1,
          reason: "test-compaction",
        })
        .returning({ id: documentYjsCheckpoints.id });
      await db.insert(documentYjsHeads).values({
        documentId: DOC_ID as never,
        schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
        latestUpdateSeq: 1,
        latestStateVector: Buffer.from(Y.encodeStateVector(live)),
        latestCheckpointId: checkpoint?.id ?? null,
      });
      await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: live,
      });
    });

    it("commitPushBatch rejects stale draft snapshots and non-active source rows", async () => {
      const pushStore = createDrizzlePushCommitStore(
        db,
        stageSettlementBatchWithinTx,
        createDrizzleChangeTrailAggregateWriter(db),
        undefined,
        createTestWorkProjectionMutation(db),
      );
      const journalReadStore = createDrizzleDraftJournalReadStore(db);
      const documentDraft = await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: docWithText("live"),
      });
      const draftDoc = docWithText("draft");
      const update = Y.encodeStateAsUpdate(draftDoc, Y.encodeStateVector(docWithText("live")));
      const [journalRow] = await db
        .insert(draftWriteJournal)
        .values({
          draftId: documentDraft.draftId,
          generation: documentDraft.generation,
          updateData: Buffer.from(update),
          draftBaseUpdateSeq: 0,
          source: "agent",
        })
        .returning();
      if (!journalRow) throw new Error("missing journal row");

      // A concurrent committed write moves the revision the push was prepared at.
      await db
        .update(documentDrafts)
        .set({ revision: documentDraft.revision + 1 })
        .where(eq(documentDrafts.id, documentDraft.draftId));
      await expect(
        pushStore.commitPushBatch(
          batchOfOne({
            documentDraft,
            journalRows: [
              {
                id: journalRow.id,
                draftId: documentDraft.draftId,
                generation: documentDraft.generation,
                wId: null,
                source: "agent",
                threadId: null,
                turnId: null,
                actorUserId: null,
                updateData: update,
                draftBaseUpdateSeq: journalRow.draftBaseUpdateSeq,
                status: "active",
              },
            ],
            pushUpdate: update,
            idempotencyKey: "stale-draft",
            trail: {
              documentId: DOC_ID,
              documentTitle: "document",
              receiptId: "receipt",
              threadIds: [],
              journalOwners: [],
              changes: [],
            },
            documentTitle: "document",
            lockCutUpdate: Y.encodeStateAsUpdate(draftDoc),
          }),
        ),
      ).rejects.toThrow("changed before its push could commit");
      await expect(db.select().from(pushLineage)).resolves.toHaveLength(0);

      const fresh = await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: docWithText("live"),
      });
      const freshRows = await journalReadStore.listActiveJournalRows(
        fresh.draftId,
        fresh.generation,
      );
      await db
        .update(draftWriteJournal)
        .set({ status: "discarded" })
        .where(eq(draftWriteJournal.id, journalRow.id));
      await expect(
        pushStore.commitPushBatch(
          batchOfOne({
            documentDraft: fresh,
            journalRows: freshRows,
            pushUpdate: update,
            idempotencyKey: "inactive-row",
            trail: {
              documentId: DOC_ID,
              documentTitle: "document",
              receiptId: "receipt",
              threadIds: [],
              journalOwners: [],
              changes: [],
            },
            documentTitle: "document",
            lockCutUpdate: Y.encodeStateAsUpdate(draftDoc),
          }),
        ),
      ).rejects.toThrow("changed before its push could commit");
      await expect(db.select().from(pushLineage)).resolves.toHaveLength(0);
    });

    it("commitPushBatch leaves no pending command behind when a lineage conflict ends staging", async () => {
      const pushStore = createDrizzlePushCommitStore(
        db,
        stageSettlementBatchWithinTx,
        createDrizzleChangeTrailAggregateWriter(db),
        undefined,
        createTestWorkProjectionMutation(db),
      );
      const journalReadStore = createDrizzleDraftJournalReadStore(db);
      const documentDraft = await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: docWithText("live"),
      });
      const update = Y.encodeStateAsUpdate(
        docWithText("draft"),
        Y.encodeStateVector(docWithText("live")),
      );
      await db.insert(draftWriteJournal).values({
        draftId: documentDraft.draftId,
        generation: documentDraft.generation,
        updateData: Buffer.from(update),
        draftBaseUpdateSeq: 0,
        source: "agent",
      });
      const journalRows = await journalReadStore.listActiveJournalRows(
        documentDraft.draftId,
        documentDraft.generation,
      );
      const command = (commandId: string, batchId: string) => ({
        ...batchOfOne({
          documentDraft,
          journalRows,
          pushUpdate: update,
          idempotencyKey: "one-cut",
          trail: {
            documentId: DOC_ID,
            documentTitle: "document",
            receiptId: "receipt",
            threadIds: [],
            journalOwners: [],
            changes: [],
          },
          documentTitle: "document",
          lockCutUpdate: update,
        }),
        settlement: {
          batchId,
          claimToken: "00000000-0000-4000-8000-0000000006f9",
        },
        command: {
          commandId: commandId as never,
          workId: WORK_ID as never,
          accountId: USER_ID as never,
          kind: "apply_items" as const,
          branchId: BRANCH_ID as never,
          digest: commandId,
        },
      });
      // Another process already staged this exact cut under its own command.
      await db.insert(pushLineage).values({
        draftId: documentDraft.draftId,
        draftGeneration: documentDraft.generation,
        documentId: DOC_ID as never,
        journalIds: journalRows.map((row) => row.id),
        idempotencyKey: "one-cut",
      });
      const second = command(
        "00000000-0000-4000-8000-0000000006c2",
        "00000000-0000-4000-8000-0000000006b2",
      );
      expect(await pushStore.commitPushBatch(second as never)).toMatchObject({
        status: "conflict",
      });
      const claimed = await db.select().from(branchCommands);
      expect(claimed).toEqual([]);
    });

    it("G2 §6.1 entry corrupt snapshot fails loudly at draft-room load", async () => {
      const { DraftCorruptError } = await import("../../domain/draft-resolver.js");
      await db.insert(documentDrafts).values({
        id: "draft_corrupt_review_entry",
        documentId: DOC_ID as never,
        kind: "work_draft",
        upstreamDraftId: null,
        branchId: BRANCH_ID as never,
        threadId: null,
        status: "active",
        state: Buffer.from([1, 2]),
        stateVector: Buffer.from([0]),
        schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
      });
      const persistence = draftRoomPersistence();

      await expect(
        persistence.loadHocuspocusDraftState("draft_corrupt_review_entry", 1),
      ).rejects.toThrow(DraftCorruptError);
    });

    it("never makes a draft in a closed branch: a captured branch's draft stays closed after its close", async () => {
      const { runInDrizzleTransaction } = await import("../../../../shared/drizzle-transaction.js");
      const branchStore = createDrizzleBranchStore(db);
      // Review captured the Work's active branch and its draft, then a whole close ended it.
      const captured = await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: docWithText("live"),
      });
      await runInDrizzleTransaction(db, async () => {
        await branchStore.lockActive(BRANCH_ID as never);
        // The Discard kernel closes the drafts first; the store closes only the row.
        await db
          .update(documentDrafts)
          .set({ status: "closed" })
          .where(eq(documentDrafts.branchId, BRANCH_ID as never));
        await branchStore.close(BRANCH_ID as never, new Date());
      });
      const before = await db
        .select({ id: documentDrafts.id, status: documentDrafts.status })
        .from(documentDrafts)
        .where(eq(documentDrafts.branchId, BRANCH_ID as never));

      expect
        .soft((await store.getDraft(captured.draftId))?.status, "the captured draft is closed")
        .toBe("closed");
      await expect
        .soft(
          store.ensureDocumentDraft({
            documentId: DOC_ID as never,
            branchId: BRANCH_ID as never,
            liveDoc: docWithText("live"),
          }),
          "a write boundary refuses the closed branch",
        )
        .rejects.toMatchObject({ name: "DraftStaleUpdateError" });
      expect
        .soft(
          await db
            .select({ id: documentDrafts.id, status: documentDrafts.status })
            .from(documentDrafts)
            .where(eq(documentDrafts.branchId, BRANCH_ID as never)),
          "and no draft row is added",
        )
        .toEqual(before);
    });

    it("G2 §6.1 corrupt recovery resets from live without decoding the corrupt snapshot", async () => {
      await db.insert(documentDrafts).values({
        id: "draft_corrupt_preview_reset",
        documentId: DOC_ID as never,
        kind: "work_draft",
        upstreamDraftId: null,
        branchId: BRANCH_ID as never,
        threadId: null,
        status: "active",
        state: Buffer.from([1, 2]),
        stateVector: Buffer.from([0]),
        schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
      });
      const coordinator = createDraftCoordinator({ onAppendCommitted: () => {}, store });

      await expect(
        resetDraftFromDoc(
          coordinator,
          store,
          "draft_corrupt_preview_reset",
          docWithText("live repair"),
        ),
      ).resolves.toBe(true);

      const repaired = await readResolvedDraft(store, {
        draftId: "draft_corrupt_preview_reset",
      });
      expect(repaired.generation).toBeGreaterThan(1);
      expect(repaired.doc.getText("content").toString()).toBe("live repair");
      repaired.doc.destroy();
    });

    it("G2 §6.1 entry mid-reset rebinds to the bumped generation draft room", async () => {
      const coordinator = createDraftCoordinator({ onAppendCommitted: () => {}, store });
      const documentDraft = await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: docWithText("before reset"),
      });
      await resetDraftFromDoc(
        coordinator,
        store,
        documentDraft.draftId,
        docWithText("after reset"),
      );
      const persistence = draftRoomPersistence();

      const freshGeneration = documentDraft.generation + 1;
      const room = await persistence.resolveDraftHocuspocusRoom(
        documentDraft.draftId,
        freshGeneration,
      );
      const loaded = (
        await persistence.loadHocuspocusDraftState(documentDraft.draftId, freshGeneration)
      )?.state;
      const loadedDoc = new Y.Doc({ gc: false });
      if (loaded) Y.applyUpdate(loadedDoc, loaded);

      expect(room?.generation).toBe(freshGeneration);
      expect(loadedDoc.getText("content").toString()).toBe("after reset");
    });

    it("G2 §6.1 entry connect failure is a typed draft-room miss, never live fallback", async () => {
      const { parseYjsRoomName } = await import("@meridian/contracts/protocol");
      const persistence = draftRoomPersistence();

      expect(parseYjsRoomName("draft:missing-review-draft:gen:1")).toEqual({
        kind: "draft",
        draftId: "missing-review-draft",
        generation: 1,
      });
      expect(parseYjsRoomName("draft:missing-review-draft")).toBeNull();
      await expect(
        persistence.resolveDraftHocuspocusRoom("missing-review-draft", 1),
      ).resolves.toBeNull();
      await expect(
        persistence.loadHocuspocusDraftState("missing-review-draft", 1),
      ).resolves.toBeUndefined();
    });
    it("captures an immutable live journal draftBase for each new draft row", async () => {
      const live = docWithText("base");
      const firstSeq = await livePersistence.journal.append(DOC_ID, Y.encodeStateAsUpdate(live), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
      const documentDraft = await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: live,
      });
      await appendDraftRows(store, documentDraft.draftId, [
        { updateData: proseDraftUpdate(), source: "agent" },
      ]);

      const beforeSecond = Y.encodeStateVector(live);
      live.getText("content").insert(live.getText("content").length, " later");
      const secondSeq = await livePersistence.journal.append(
        DOC_ID,
        Y.encodeStateAsUpdate(live, beforeSecond),
        { origin: `human:${USER_ID}`, seq: 0 },
      );
      await appendDraftRows(store, documentDraft.draftId, [
        { updateData: proseDraftUpdate(), source: "agent" },
      ]);

      const rows = await db
        .select({ draftBaseUpdateSeq: draftWriteJournal.draftBaseUpdateSeq })
        .from(draftWriteJournal)
        .where(eq(draftWriteJournal.draftId, documentDraft.draftId))
        .orderBy(draftWriteJournal.id);
      expect(rows).toEqual([{ draftBaseUpdateSeq: firstSeq }, { draftBaseUpdateSeq: secondSeq }]);
    });
    // Risk: an append is sequenced by the row lock, not fenced by the revision (design §2):
    // it lands at any revision, refuses only a closed, re-forked or frozen draft, and an
    // outcome that writes nothing must roll its bump back even inside a caller's transaction.
    it("an append lands at any revision, refuses a closed draft, and rolls back what it does not write", async () => {
      const documentDraft = await store.ensureDocumentDraft({
        documentId: DOC_ID as never,
        branchId: BRANCH_ID as never,
        liveDoc: docWithText("seed"),
      });
      const row = (updateData: Uint8Array) => ({
        draftId: documentDraft.draftId,
        generation: documentDraft.generation,
        updateData,
        source: "agent" as const,
      });
      const append = (
        status: "contained" | "prefixMissing" | null,
        updateData = Y.encodeStateAsUpdate(docWithText("changed")),
      ) =>
        store.appendRows({
          draftId: documentDraft.draftId,
          documentId: DOC_ID as never,
          expectedGeneration: documentDraft.generation,
          base: { checkpointRevision: 0, seq: 0 },
          finalize: () =>
            status === "contained"
              ? { status }
              : status === "prefixMissing"
                ? { status, clocks: [] }
                : { status: "appended", rows: [row(updateData)], receipts: [] },
        });
      // Another write moved the revision: the append still lands, at the next one.
      await db
        .update(documentDrafts)
        .set({ revision: documentDraft.revision + 5 })
        .where(eq(documentDrafts.id, documentDraft.draftId));
      await expect(append(null)).resolves.toMatchObject({
        status: "appended",
        revision: documentDraft.revision + 6,
      });
      const revision = documentDraft.revision + 6;
      const { runInDrizzleTransaction } = await import("../../../../shared/drizzle-transaction.js");
      // Inside an ambient transaction that commits: the outcome's savepoint unwinds the bump.
      for (const status of ["contained", "prefixMissing"] as const) {
        await runInDrizzleTransaction(db, async () => {
          await expect(append(status)).resolves.toMatchObject({ status });
        });
        expect((await store.getDraft(documentDraft.draftId))?.revision).toBe(revision);
      }
      await db
        .update(documentDrafts)
        .set({ generation: documentDraft.generation + 1 })
        .where(eq(documentDrafts.id, documentDraft.draftId));
      await expect(append(null)).resolves.toEqual({ status: "refused" });
      const journalRows = await db
        .select({ id: draftWriteJournal.id })
        .from(draftWriteJournal)
        .where(eq(draftWriteJournal.draftId, documentDraft.draftId));
      expect(journalRows).toHaveLength(1);
    });
  });
}

function batchOfOne<T>(prepared: T) {
  return {
    settlement: {
      batchId: "00000000-0000-4000-8000-000000000698",
      claimToken: "00000000-0000-4000-8000-000000000699",
    },
    pushes: [prepared],
  };
}
