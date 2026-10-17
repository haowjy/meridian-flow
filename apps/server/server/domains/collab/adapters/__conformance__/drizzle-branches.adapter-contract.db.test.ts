/** Adapter-contract tests for Drizzle branch peers against local Postgres. */

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTestWorkProjectionMutation } from "../../../../test-support/work-projection.js";
import {
  commitJournaledUpdate,
  commitSegmentRows,
  resetBranchFromDoc,
} from "../../test-support/branch-update-writes.js";
import { createDrizzleDocumentDerivationStore } from "../drizzle-document-derivations.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle branch store (postgres)", () => {});
} else {
  describe("drizzle branch store adapter contract (postgres)", async () => {
    const dbSchema = await import("@meridian/database/schema");
    const {
      branchWriteJournal,
      contextSources,
      documentBranches,
      documentYjsCheckpoints,
      documentYjsHeads,
      documents,
      draftCommands,
      drafts,
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
    const { createDrizzleBranchStore } = await import("../drizzle-branches.js");
    const { appendBranchRows, EMPTY_BRANCH_UPDATE, readBranchContent, readResolvedBranch } =
      await import("../../test-support/branch-store-seam.js");
    const { createDrizzleDraftStore } = await import("../drizzle-drafts.js");
    const { createHocuspocusPersistenceService } = await import("../../hocuspocus-persistence.js");
    const {
      createDrizzleBranchJournalReadStore,
      createDrizzlePushCommitStore,
      createDrizzleWorkDraftPendingStore,
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
    const { createBranchCoordinator } = await import("../../domain/branch-coordinator.js");
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
    const DRAFT_ID = "00000000-0000-4000-8000-000000000609";
    const NEXT_DRAFT_ID = "00000000-0000-4000-8000-000000000610";
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
        await db.insert(users).values(conformanceUserValues(USER_ID, "drizzle-branches"));
        await db.insert(projects).values({
          id: PROJECT_ID,
          userId: USER_ID,
          name: "Branch Project",
          slug: "branch-project",
        });
        await db.insert(works).values({
          id: WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Branch Work",
          slug: "branch-work",
        });
        await db.insert(drafts).values({
          id: DRAFT_ID,
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
    function createBranchStore() {
      return createDrizzleBranchStore(db, {
        workProjection: createTestWorkProjectionMutation(db),
        live: {
          journal: livePersistence.journal,
          lifecycle: livePersistence.lifecycle,
        },
        drafts: createDrizzleDraftStore(db),
      });
    }

    let store = createBranchStore();

    function branchRoomPersistence(branchStore = store) {
      return createHocuspocusPersistenceService({
        journal: livePersistence.journal,
        branchStore,
        branchCoordinator: createBranchCoordinator({ store: branchStore }),
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
      const journalReadStore = createDrizzleBranchJournalReadStore(db);
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
        workDraftPendingStore: createDrizzleWorkDraftPendingStore(db),
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
      store = createBranchStore();
    });

    it("reseeds a clean thread peer under the reassigned primary Work's draft", async () => {
      const live = docWithText("live prose");
      const { branch: oldPeer } = await store.ensureThreadPeerBranch({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: live,
      });
      await db.insert(works).values({
        id: NEXT_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Next Work",
        slug: "next-work",
      });
      await db.insert(drafts).values({
        id: NEXT_DRAFT_ID,
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
        store.resolveThreadBranch(DOC_ID as never, THREAD_ID as never),
      ).rejects.toMatchObject({ name: "BranchNotFoundError" });
      const { branch: nextPeer } = await store.ensureThreadPeerBranch({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        draftId: NEXT_DRAFT_ID as never,
        liveDoc: live,
      });
      const [oldRow, nextUpstream] = await Promise.all([
        db
          .select({ status: documentBranches.status, revision: documentBranches.revision })
          .from(documentBranches)
          .where(eq(documentBranches.id, oldPeer.branchId))
          .then((rows) => rows[0]),
        store.getBranch(nextPeer.upstreamBranchId ?? ""),
      ]);

      expect(nextPeer).toMatchObject({
        draftId: NEXT_DRAFT_ID,
        workId: NEXT_WORK_ID,
        threadId: THREAD_ID,
        status: "active",
      });
      expect(nextPeer.branchId).not.toBe(oldPeer.branchId);
      // A close is a review-membership input: it moves the revision a frame predicted at (§2.5).
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
        availability,
        catalog,
        pending: createDrizzleWorkDraftPendingStore(db),
      });
      const measuredStore = createDrizzleBranchStore(db, {
        live: { journal: livePersistence.journal, lifecycle: livePersistence.lifecycle },
        workProjection: projection,
        drafts: createDrizzleDraftStore(db),
      });
      const base = docWithText("live");
      const branch = await measuredStore.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: base,
      });
      const snapshot = await measuredStore.getBranch(branch.branchId);
      if (!snapshot) throw new Error("missing batch target");
      const source = new Y.Doc({ gc: false });
      Y.applyUpdate(source, await readBranchContent(measuredStore, branch.branchId));
      const { createDrizzleJournal } = await import("../drizzle-journal.js");
      const wId = await createDrizzleJournal(db).reserveWriteOrdinal(DOC_ID, THREAD_ID);
      const rows = Array.from({ length: 40 }, (_, index) => {
        source.clientID = 10000 + index;
        const before = Y.encodeStateVector(source);
        source.getText("content").insert(source.getText("content").length, String(index));
        return {
          branchId: branch.branchId,
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
        const coordinator = createBranchCoordinator({ store: measuredStore });
        expect(
          await commitSegmentRows(coordinator, {
            branchId: branch.branchId,
            expectedGeneration: snapshot.generation,
            sourceDoc: source,
            rows,
          }),
        ).toBe(true);
      } finally {
        captureQueries = false;
      }
      // The membership flip is predicted on the candidate: the Work is touched, never counted.
      expect(
        measuredQueries.filter((query) =>
          query.startsWith('(select "drafts"."origin_work_id", "document_branches"."document_id"'),
        ),
      ).toHaveLength(0);
      expect(
        measuredQueries.filter((query) => query.startsWith('insert into "branch_write_journal"')),
      ).toHaveLength(1);
      const persisted = await db
        .select({ toolCallId: branchWriteJournal.toolCallId })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, branch.branchId))
        .orderBy(branchWriteJournal.id);
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
      const work = await store.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: live,
      });
      const resets: number[] = [];
      const coordinator = createBranchCoordinator({
        store,
        onBranchReset: ({ generation }) => resets.push(generation),
      });
      const draft = proseDoc("draft row before discard");
      const seeded = await store.getBranch(work.branchId);
      const { createDrizzleJournal } = await import("../drizzle-journal.js");
      await commitJournaledUpdate(coordinator, {
        branchId: work.branchId,
        updateData: Y.encodeStateAsUpdate(draft),
        source: "agent",
        threadId: THREAD_ID as never,
        wId: await createDrizzleJournal(db).reserveWriteOrdinal(DOC_ID, THREAD_ID),
      });
      const pendingDrafts = createDrizzleWorkDraftPendingStore(db);
      await expect(
        pendingDrafts
          .countPendingByWorkIds([WORK_ID as never])
          .then((counts) => counts.get(WORK_ID as never) ?? 0),
      ).resolves.toBe(1);

      const { runInDrizzleTransaction } = await import("../../../../shared/drizzle-transaction.js");
      const before = await store.getBranch(work.branchId);
      // The append and the reset are review-membership inputs: each moves the revision (§2.5).
      expect(before?.revision).toBeGreaterThan(seeded?.revision ?? Number.POSITIVE_INFINITY);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await resetBranchFromDoc(coordinator, store, work.branchId, live);
          expect(resets).toEqual([]);
          throw new Error("abort composite discard");
        }),
      ).rejects.toThrow("abort composite discard");
      expect(await store.getBranch(work.branchId)).toEqual(before);
      expect(resets).toEqual([]);
      await resetBranchFromDoc(coordinator, store, work.branchId, live);
      expect(resets).toEqual([work.generation + 1]);
      expect((await store.getBranch(work.branchId))?.revision).toBeGreaterThan(
        before?.revision ?? Number.POSITIVE_INFINITY,
      );

      await expect(
        pendingDrafts
          .countPendingByWorkIds([WORK_ID as never])
          .then((counts) => counts.get(WORK_ID as never) ?? 0),
      ).resolves.toBe(0);
      const rows = await db
        .select({ generation: branchWriteJournal.generation, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, work.branchId));
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
      await store.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: live,
      });
    });

    it("commitPushBatch rejects stale branch snapshots and non-active source rows", async () => {
      const pushStore = createDrizzlePushCommitStore(
        db,
        stageSettlementBatchWithinTx,
        createDrizzleChangeTrailAggregateWriter(db),
        undefined,
        createTestWorkProjectionMutation(db),
      );
      const journalReadStore = createDrizzleBranchJournalReadStore(db);
      const branch = await store.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: docWithText("live"),
      });
      const branchDoc = docWithText("draft");
      const update = Y.encodeStateAsUpdate(branchDoc, Y.encodeStateVector(docWithText("live")));
      const [journalRow] = await db
        .insert(branchWriteJournal)
        .values({
          branchId: branch.branchId,
          generation: branch.generation,
          updateData: Buffer.from(update),
          draftBaseUpdateSeq: 0,
          source: "agent",
        })
        .returning();
      if (!journalRow) throw new Error("missing journal row");

      // A concurrent committed write moves the revision the push was prepared at.
      await db
        .update(documentBranches)
        .set({ revision: branch.revision + 1 })
        .where(eq(documentBranches.id, branch.branchId));
      await expect(
        pushStore.commitPushBatch(
          batchOfOne({
            branch,
            journalRows: [
              {
                id: journalRow.id,
                branchId: branch.branchId,
                generation: branch.generation,
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
            idempotencyKey: "stale-branch",
            trail: {
              documentId: DOC_ID,
              documentTitle: "document",
              receiptId: "receipt",
              threadIds: [],
              journalOwners: [],
              changes: [],
            },
            documentTitle: "document",
            lockCutUpdate: Y.encodeStateAsUpdate(branchDoc),
          }),
        ),
      ).rejects.toThrow("changed before its push could commit");
      await expect(db.select().from(pushLineage)).resolves.toHaveLength(0);

      const fresh = await store.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: docWithText("live"),
      });
      const freshRows = await journalReadStore.listActiveJournalRows(
        fresh.branchId,
        fresh.generation,
      );
      await db
        .update(branchWriteJournal)
        .set({ status: "discarded" })
        .where(eq(branchWriteJournal.id, journalRow.id));
      await expect(
        pushStore.commitPushBatch(
          batchOfOne({
            branch: fresh,
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
            lockCutUpdate: Y.encodeStateAsUpdate(branchDoc),
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
      const journalReadStore = createDrizzleBranchJournalReadStore(db);
      const branch = await store.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: docWithText("live"),
      });
      const update = Y.encodeStateAsUpdate(
        docWithText("draft"),
        Y.encodeStateVector(docWithText("live")),
      );
      await db.insert(branchWriteJournal).values({
        branchId: branch.branchId,
        generation: branch.generation,
        updateData: Buffer.from(update),
        draftBaseUpdateSeq: 0,
        source: "agent",
      });
      const journalRows = await journalReadStore.listActiveJournalRows(
        branch.branchId,
        branch.generation,
      );
      const command = (commandId: string, batchId: string) => ({
        ...batchOfOne({
          branch,
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
          draftId: DRAFT_ID as never,
          digest: commandId,
        },
      });
      // Another process already staged this exact cut under its own command.
      await db.insert(pushLineage).values({
        branchId: branch.branchId,
        branchGeneration: branch.generation,
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
      const claimed = await db.select().from(draftCommands);
      expect(claimed).toEqual([]);
    });

    it("G2 §6.1 entry corrupt snapshot fails loudly at branch-room load", async () => {
      const { BranchCorruptError } = await import("../../domain/branch-resolver.js");
      await db.insert(documentBranches).values({
        id: "branch_corrupt_review_entry",
        documentId: DOC_ID as never,
        kind: "work_draft",
        upstreamBranchId: null,
        draftId: DRAFT_ID as never,
        threadId: null,
        status: "active",
        state: Buffer.from([1, 2]),
        stateVector: Buffer.from([0]),
        schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
      });
      const persistence = branchRoomPersistence();

      await expect(
        persistence.loadHocuspocusBranchState("branch_corrupt_review_entry", 1),
      ).rejects.toThrow(BranchCorruptError);
    });

    it("never makes a branch in a closed draft: a captured draft's branch stays closed after its close", async () => {
      const { runInDrizzleTransaction } = await import("../../../../shared/drizzle-transaction.js");
      const draftStore = createDrizzleDraftStore(db);
      // Review captured the Work's active draft and its branch, then a whole close ended it.
      const captured = await store.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: docWithText("live"),
      });
      await runInDrizzleTransaction(db, async () => {
        await draftStore.lockActive(DRAFT_ID as never);
        // The Discard kernel closes the branches first; the store closes only the row.
        await db
          .update(documentBranches)
          .set({ status: "closed" })
          .where(eq(documentBranches.draftId, DRAFT_ID as never));
        await draftStore.close(DRAFT_ID as never, new Date());
      });
      const before = await db
        .select({ id: documentBranches.id, status: documentBranches.status })
        .from(documentBranches)
        .where(eq(documentBranches.draftId, DRAFT_ID as never));

      expect
        .soft((await store.getBranch(captured.branchId))?.status, "the captured branch is closed")
        .toBe("closed");
      await expect
        .soft(
          store.ensureDraftBranch({
            documentId: DOC_ID as never,
            draftId: DRAFT_ID as never,
            liveDoc: docWithText("live"),
          }),
          "a write boundary refuses the closed draft",
        )
        .rejects.toMatchObject({ name: "BranchStaleUpdateError" });
      expect
        .soft(
          await db
            .select({ id: documentBranches.id, status: documentBranches.status })
            .from(documentBranches)
            .where(eq(documentBranches.draftId, DRAFT_ID as never)),
          "and no branch row is added",
        )
        .toEqual(before);
    });

    it("G2 §6.1 corrupt recovery resets from live without decoding the corrupt snapshot", async () => {
      await db.insert(documentBranches).values({
        id: "branch_corrupt_preview_reset",
        documentId: DOC_ID as never,
        kind: "work_draft",
        upstreamBranchId: null,
        draftId: DRAFT_ID as never,
        threadId: null,
        status: "active",
        state: Buffer.from([1, 2]),
        stateVector: Buffer.from([0]),
        schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
      });
      const coordinator = createBranchCoordinator({ store });

      await expect(
        resetBranchFromDoc(
          coordinator,
          store,
          "branch_corrupt_preview_reset",
          docWithText("live repair"),
        ),
      ).resolves.toBe(true);

      const repaired = await readResolvedBranch(store, {
        branchId: "branch_corrupt_preview_reset",
      });
      expect(repaired.generation).toBeGreaterThan(1);
      expect(repaired.doc.getText("content").toString()).toBe("live repair");
      repaired.doc.destroy();
    });

    it("G2 §6.1 entry mid-reset rebinds to the bumped generation branch room", async () => {
      const coordinator = createBranchCoordinator({ store });
      const branch = await store.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: docWithText("before reset"),
      });
      await resetBranchFromDoc(coordinator, store, branch.branchId, docWithText("after reset"));
      const persistence = branchRoomPersistence();

      const freshGeneration = branch.generation + 1;
      const room = await persistence.resolveBranchHocuspocusRoom(branch.branchId, freshGeneration);
      const loaded = (await persistence.loadHocuspocusBranchState(branch.branchId, freshGeneration))
        ?.state;
      const loadedDoc = new Y.Doc({ gc: false });
      if (loaded) Y.applyUpdate(loadedDoc, loaded);

      expect(room?.generation).toBe(freshGeneration);
      expect(loadedDoc.getText("content").toString()).toBe("after reset");
    });

    it("G2 §6.1 entry connect failure is a typed branch-room miss, never live fallback", async () => {
      const { parseYjsRoomName } = await import("@meridian/contracts/protocol");
      const persistence = branchRoomPersistence();

      expect(parseYjsRoomName("branch:missing-review-branch:gen:1")).toEqual({
        kind: "branch",
        branchId: "missing-review-branch",
        generation: 1,
      });
      expect(parseYjsRoomName("branch:missing-review-branch")).toBeNull();
      await expect(
        persistence.resolveBranchHocuspocusRoom("missing-review-branch", 1),
      ).resolves.toBeNull();
      await expect(
        persistence.loadHocuspocusBranchState("missing-review-branch", 1),
      ).resolves.toBeUndefined();
    });
    it("captures an immutable live journal draftBase for each new draft row", async () => {
      const live = docWithText("base");
      const firstSeq = await livePersistence.journal.append(DOC_ID, Y.encodeStateAsUpdate(live), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
      const branch = await store.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: live,
      });
      await appendBranchRows(store, branch.branchId, [
        { updateData: EMPTY_BRANCH_UPDATE, source: "agent" },
      ]);

      const beforeSecond = Y.encodeStateVector(live);
      live.getText("content").insert(live.getText("content").length, " later");
      const secondSeq = await livePersistence.journal.append(
        DOC_ID,
        Y.encodeStateAsUpdate(live, beforeSecond),
        { origin: `human:${USER_ID}`, seq: 0 },
      );
      await appendBranchRows(store, branch.branchId, [
        { updateData: EMPTY_BRANCH_UPDATE, source: "agent" },
      ]);

      const rows = await db
        .select({ draftBaseUpdateSeq: branchWriteJournal.draftBaseUpdateSeq })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, branch.branchId))
        .orderBy(branchWriteJournal.id);
      expect(rows).toEqual([{ draftBaseUpdateSeq: firstSeq }, { draftBaseUpdateSeq: secondSeq }]);
    });
    // Risk: the revision predicate is the write fence that replaced the byte compare; an
    // append judged at a revision another write moved (or carrying another generation's rows)
    // must leave the branch exactly as it was.
    it("refuses an append judged at a moved revision or for another generation", async () => {
      const branch = await store.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: docWithText("seed"),
      });
      const before = await readBranchContent(store, branch.branchId);
      const changed = docWithText("changed");
      const updateData = Y.encodeStateAsUpdate(changed);
      const append = (revision: number, generation: number) =>
        store.appendRows({
          branchId: branch.branchId,
          expectedRevision: revision,
          expectedGeneration: branch.generation,
          documentId: DOC_ID as never,
          rows: [{ branchId: branch.branchId, generation, updateData, source: "agent" }],
          receipts: [],
        });

      await expect(append(branch.revision, branch.generation + 1)).resolves.toEqual({
        status: "moved",
      });
      await db
        .update(documentBranches)
        .set({ revision: branch.revision + 1 })
        .where(eq(documentBranches.id, branch.branchId));
      await expect(append(branch.revision, branch.generation)).resolves.toEqual({
        status: "moved",
      });
      const reloaded = await store.getBranch(branch.branchId);
      const journalRows = await db
        .select({ id: branchWriteJournal.id })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, branch.branchId));

      expect(reloaded).toMatchObject({
        generation: branch.generation,
        revision: branch.revision + 1,
      });
      expect(journalRows).toEqual([]);
      expect(await readBranchContent(store, branch.branchId)).toEqual(before);
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
