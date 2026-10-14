/** Adapter-contract tests for Drizzle branch peers against local Postgres. */

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { commitSegmentRows } from "../../test-support/branch-update-writes.js";

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

    beforeEach(async () => {
      db = database.current;
      livePersistence = createDrizzleCollabPersistence(db);
      store = createBranchStore();
    });

    it("reseeds a clean thread peer under the reassigned primary Work's draft", async () => {
      const live = docWithText("live prose");
      const oldPeer = await store.ensureThreadPeerBranch({
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
      const nextPeer = await store.ensureThreadPeerBranch({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        draftId: NEXT_DRAFT_ID as never,
        liveDoc: live,
      });
      const [oldRow, nextUpstream] = await Promise.all([
        db
          .select({ status: documentBranches.status })
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
      expect(oldRow?.status).toBe("closed");
      expect(nextUpstream?.workId).toBe(NEXT_WORK_ID);
    });

    it("bulk-appends forty segment rows with one ownership lookup and two pending scans", async () => {
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
      Y.applyUpdate(source, snapshot.state);
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
      expect(
        measuredQueries.filter((query) =>
          query.startsWith(
            '(select "drafts"."id", "drafts"."origin_work_id", "document_branches"."document_id"',
          ),
        ),
      ).toHaveLength(2);
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

    it("commitPushBatch leaves no pending command behind when a lineage conflict ends staging", async () => {
      const pushStore = createDrizzlePushCommitStore(
        db,
        stageSettlementBatchWithinTx,
        createDrizzleChangeTrailAggregateWriter(db),
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
      const command = (commandId: string, batchId: string) => ({
        ...batchOfOne({
          branch,
          input: { scope: "item" as const, snapshot: "" },
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
        journalIds: [],
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
        persistence.loadHocuspocusBranchState("branch_corrupt_review_entry"),
      ).rejects.toThrow(BranchCorruptError);
    });

    it("never makes a branch in a closed draft: a review read of a captured draft after its close finds nothing", async () => {
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

      await expect
        .soft(
          store.resolveDraftBranch({
            draftBranchId: captured.branchId,
            documentId: DOC_ID as never,
            draftId: DRAFT_ID as never,
          }),
          "the review read finds no branch",
        )
        .rejects.toMatchObject({ name: "BranchNotFoundError" });
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

    it("G2 §6.1 entry connect failure is a typed branch-room miss, never live fallback", async () => {
      const { parseYjsRoomName } = await import("@meridian/contracts/protocol");
      const persistence = branchRoomPersistence();

      expect(parseYjsRoomName("branch:missing-review-branch")).toEqual({
        kind: "branch",
        branchId: "missing-review-branch",
      });
      expect(parseYjsRoomName("branch:")).toBeNull();
      await expect(
        persistence.resolveBranchHocuspocusRoom("missing-review-branch"),
      ).resolves.toBeNull();
      await expect(
        persistence.loadHocuspocusBranchState("missing-review-branch"),
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
      await store.appendJournal?.({
        branchId: branch.branchId,
        generation: branch.generation,
        updateData: new Uint8Array(),
        source: "agent",
      });

      const beforeSecond = Y.encodeStateVector(live);
      live.getText("content").insert(live.getText("content").length, " later");
      const secondSeq = await livePersistence.journal.append(
        DOC_ID,
        Y.encodeStateAsUpdate(live, beforeSecond),
        { origin: `human:${USER_ID}`, seq: 0 },
      );
      await store.appendJournal?.({
        branchId: branch.branchId,
        generation: branch.generation,
        updateData: new Uint8Array(),
        source: "agent",
      });

      const rows = await db
        .select({ draftBaseUpdateSeq: branchWriteJournal.draftBaseUpdateSeq })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, branch.branchId))
        .orderBy(branchWriteJournal.id);
      expect(rows).toEqual([{ draftBaseUpdateSeq: firstSeq }, { draftBaseUpdateSeq: secondSeq }]);
    });
    it("rejects a staged reversal after Apply changes the planned row status", async () => {
      const branch = await store.ensureDraftBranch({
        documentId: DOC_ID as never,
        draftId: DRAFT_ID as never,
        liveDoc: docWithText("seed"),
      });
      await store.appendJournal?.({
        branchId: branch.branchId,
        generation: branch.generation,
        updateData: new Uint8Array(),
        source: "agent",
      });
      const [planned] = await db
        .select({ id: branchWriteJournal.id })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, branch.branchId));
      if (!planned) throw new Error("expected planned branch row");
      await db
        .update(branchWriteJournal)
        .set({ status: "pushed" })
        .where(eq(branchWriteJournal.id, planned.id));

      const changed = docWithText("changed");
      const committed = await store.commitBranchMutation?.({
        branchId: branch.branchId,
        expectedState: branch.state,
        effect: { kind: "text", hasEffect: false },
        state: Y.encodeStateAsUpdate(changed),
        stateVector: Y.encodeStateVector(changed),
        journals: [
          {
            branchId: branch.branchId,
            generation: branch.generation,
            expectedJournalWatermark: planned.id,
            expectedJournalRevision: `${planned.id}:active`,
            updateData: Y.encodeStateAsUpdate(changed),
            source: "agent",
          },
        ],
      });
      const reloaded = await store.getBranch(branch.branchId);
      const rows = await db
        .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, branch.branchId));

      expect(committed).toBe(false);
      expect(reloaded?.state).toEqual(branch.state);
      expect(rows).toEqual([{ id: planned.id, status: "pushed" }]);
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
