/** Adapter-contract tests for Drizzle branch peers against local Postgres. */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NO_DOCUMENT_ASSET_PATHS } from "../../domain/ports/document-asset-paths.js";
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
      changeTrailDeliveryOutbox,
      changeTrailDocumentDetails,
      changeTrailShells,
      contextSources,
      documentBranches,
      documentYjsCheckpoints,
      documentYjsHeads,
      documents,
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
    const { createHocuspocusPersistenceService } = await import("../../hocuspocus-persistence.js");
    const {
      createDrizzleBranchJournalReadStore,
      createDrizzlePushCommitStore,
      createDrizzleWorkDraftPendingStore,
      createDrizzleWorkPushPolicyStore,
    } = await import("../drizzle-branch-push.js");
    const { createDrizzlePendingSettlementStore, stagePendingSettlementWithinTx } = await import(
      "../drizzle-pending-settlement.js"
    );
    const { createDrizzleChangeTrailAggregateWriter } = await import(
      "../drizzle-change-trail-aggregate.js"
    );
    const { createDrizzleDocumentProjectionEffects } = await import(
      "../drizzle-document-activity.js"
    );
    const { createDrizzleCollabPersistence } = await import("../drizzle-journal.js");
    const { createCollabYDoc } = await import("@meridian/prosemirror-schema");
    const { createBranchCoordinator } = await import("../../domain/branch-coordinator.js");
    const { createBranchPushService } = await import("../../domain/branch-push.js");
    const { createWorkDraftPending } = await import("../../domain/work-draft-pending.js");
    const { mdxCodec, unresolvedAssetPathResolver } = await import("@meridian/markup");
    const { toDocHandle, yProsemirrorModel } = await import("@meridian/agent-edit/integration");
    const { buildDocumentSchema } = await import("@meridian/prosemirror-schema");
    const { resolveDocumentUri } = await import("../../../context/document-uri-resolver.js");
    const { createDrizzleProjectWorkAuthorityResolver } = await import(
      "../../../projects/index.js"
    );
    const { COLLAB_SCHEMA_VERSION, packCollabSchemaVersion } = await import(
      "@meridian/prosemirror-schema"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000601";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000602";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000603";
    const WORK_ID = "00000000-0000-4000-8000-000000000604";
    const NEXT_WORK_ID = "00000000-0000-4000-8000-000000000608";
    const DOC_ID = "00000000-0000-4000-8000-000000000605";
    const THREAD_ID = "00000000-0000-4000-8000-000000000606";
    const TURN_ID = "00000000-0000-4000-8000-000000000607";

    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
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
          extension: "md",
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
    const liveDocs = new Map<string, Y.Doc>();
    const liveCoordinator = {
      async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
        let doc = liveDocs.get(docId);
        if (!doc) {
          doc = createCollabYDoc({ gc: false });
          const snapshot = await livePersistence.journal.read(docId);
          if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
          for (const update of snapshot.updates) Y.applyUpdate(doc, update.update);
          liveDocs.set(docId, doc);
        }
        return fn(doc);
      },
      async recover() {},
    };
    function createBranchStore() {
      return createDrizzleBranchStore(db, {
        journal: livePersistence.journal,
        lifecycle: livePersistence.lifecycle,
        coordinator: liveCoordinator,
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
        latestUpdateSeq: async () => 0,
        emitAgentEditInvariantViolation: () => undefined,
      });
    }

    function docWithText(value: string): Y.Doc {
      const doc = new Y.Doc({ gc: false });
      doc.getText("content").insert(0, value);
      return doc;
    }

    const markdownProjectionSerializer = (
      model: ReturnType<typeof yProsemirrorModel>,
      codec: ReturnType<typeof mdxCodec>,
    ) => ({
      async serializeDocument(_documentId: string, doc: Y.Doc) {
        return codec.serialize(model.projectBlocks(toDocHandle(doc)));
      },
    });
    const createPushStores = (
      serializer: Parameters<typeof createDrizzlePendingSettlementStore>[1],
      changeTrails: Parameters<
        typeof createDrizzlePushCommitStore
      >[2] = createDrizzleChangeTrailAggregateWriter(db),
    ) => {
      const journalReadStore = createDrizzleBranchJournalReadStore(db);
      const commitStore = createDrizzlePushCommitStore(
        db,
        stagePendingSettlementWithinTx,
        changeTrails,
      );
      return {
        journalReadStore,
        commitStore,
        workPushPolicyStore: createDrizzleWorkPushPolicyStore(db),
        workDraftPendingStore: createDrizzleWorkDraftPendingStore(db),
        settlementStore: createDrizzlePendingSettlementStore(
          db,
          serializer,
          createDrizzleDocumentProjectionEffects(db),
          changeTrails,
          createDrizzleDocumentDerivationStore(db, (tx, id) =>
            resolveDocumentUri(tx, createDrizzleProjectWorkAuthorityResolver(db), id),
          ),
        ),
      };
    };

    beforeEach(async () => {
      db = database.current;
      livePersistence = createDrizzleCollabPersistence(db);
      store = createBranchStore();
      await store.reconcileProjectManifest(PROJECT_ID as never);
    });

    afterEach(() => {
      for (const doc of liveDocs.values()) doc.destroy();
      liveDocs.clear();
    });

    it("reseeds a clean thread peer under the reassigned primary Work", async () => {
      const live = docWithText("live prose");
      const oldPeer = await store.ensureThreadPeerBranch({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        liveDoc: live,
      });
      await db.insert(works).values({
        id: NEXT_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Next Work",
        slug: "next-work",
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
        liveDoc: live,
      });
      const [oldRow, nextUpstream] = await Promise.all([
        db
          .select({ status: documentBranches.status })
          .from(documentBranches)
          .where(eq(documentBranches.id, oldPeer.branchId))
          .then((rows) => rows[0]),
        db
          .select({ workId: documentBranches.workId })
          .from(documentBranches)
          .where(eq(documentBranches.id, nextPeer.upstreamBranchId ?? ""))
          .then((rows) => rows[0]),
      ]);

      expect(nextPeer).toMatchObject({
        workId: NEXT_WORK_ID,
        threadId: THREAD_ID,
        status: "active",
      });
      expect(nextPeer.branchId).not.toBe(oldPeer.branchId);
      expect(oldRow?.status).toBe("closed");
      expect(nextUpstream?.workId).toBe(NEXT_WORK_ID);
    });

    it("discard/reset marks old-generation rows discarded and unpushed counts join the active generation", async () => {
      const live = docWithText("live base");
      const work = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: live,
      });
      const resets: number[] = [];
      const coordinator = createBranchCoordinator({
        store,
        onBranchReset: ({ generation }) => resets.push(generation),
      });
      const draft = docWithText("draft row before discard");
      await coordinator.commitUpdate({
        branchId: work.branchId,
        updateData: Y.encodeStateAsUpdate(draft),
        source: "agent",
        threadId: THREAD_ID as never,
      });
      const pendingDrafts = createWorkDraftPending(createDrizzleWorkDraftPendingStore(db));
      await expect(
        pendingDrafts
          .countPendingByWorkIds([WORK_ID as never])
          .then((counts) => counts.get(WORK_ID as never) ?? 0),
      ).resolves.toBe(1);

      const { runInDrizzleTransaction } = await import("../../../../shared/drizzle-transaction.js");
      const before = await store.getBranch(work.branchId);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await coordinator.resetFromDoc(work.branchId, live);
          expect(resets).toEqual([]);
          throw new Error("abort composite discard");
        }),
      ).rejects.toThrow("abort composite discard");
      expect(await store.getBranch(work.branchId)).toEqual(before);
      expect(resets).toEqual([]);
      await coordinator.resetFromDoc(work.branchId, live);
      expect(resets).toEqual([work.generation + 1]);

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
      await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: live,
      });

      await expect(
        store.resolveManifestMembership({ projectId: PROJECT_ID as never }),
      ).resolves.toMatchObject({ members: [DOC_ID] });
    });

    it("resolves draft manifest membership for created/deleted docs while live stays untouched", async () => {
      const CREATED_ID = "00000000-0000-4000-8000-000000000608";
      await store.resolveManifestMembership({
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });
      await db.insert(documents).values({
        id: CREATED_ID as never,
        contextSourceId: SOURCE_ID,
        name: "draft-created",
        extension: "md",
        fileType: "markdown",
      });
      const manifest = await store.ensureProjectManifest({ projectId: PROJECT_ID as never });
      const work = await store.ensureWorkDraftBranch({
        documentId: manifest.documentId,
        workId: WORK_ID as never,
        liveDoc: manifest.doc,
      });
      const peer = await store.ensureThreadPeerBranch({
        documentId: manifest.documentId,
        threadId: THREAD_ID as never,
        liveDoc: manifest.doc,
      });
      const draftDoc = new Y.Doc({ gc: false });
      Y.applyUpdate(draftDoc, peer.state);
      const map = draftDoc.getMap<{ present: true }>("documents");
      const before = Y.encodeStateVector(draftDoc);
      map.delete(DOC_ID);
      map.set(CREATED_ID, { present: true });
      const update = Y.encodeStateAsUpdate(draftDoc, before);
      const coordinator = createBranchCoordinator({ store });
      await coordinator.commitUpdate({
        branchId: peer.branchId,
        updateData: update,
        source: "agent",
      });
      await coordinator.commitUpdate({
        branchId: work.branchId,
        updateData: update,
        source: "agent",
      });

      const threadView = await store.resolveManifestMembership({
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });
      const liveView = await store.resolveManifestMembership({ projectId: PROJECT_ID as never });

      expect(threadView.members).toEqual([CREATED_ID]);
      expect(liveView.members).toEqual([DOC_ID]);
    });

    it("co-promotes only the applied document manifest entry with its content push", async () => {
      const CREATED_A = "00000000-0000-4000-8000-000000000610";
      const CREATED_B = "00000000-0000-4000-8000-000000000611";
      await db.insert(documents).values([
        {
          id: CREATED_A as never,
          contextSourceId: SOURCE_ID,
          name: "created-a",
          extension: "md",
          fileType: "markdown",
        },
        {
          id: CREATED_B as never,
          contextSourceId: SOURCE_ID,
          name: "created-b",
          extension: "md",
          fileType: "markdown",
        },
      ]);
      await livePersistence.lifecycle.ensureDocument(CREATED_A as never);
      await livePersistence.lifecycle.ensureDocument(CREATED_B as never);
      const schema = buildDocumentSchema();
      const model = yProsemirrorModel(schema);
      const codec = mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver });
      const docFromMarkdown = (markdown: string) => {
        const doc = createCollabYDoc({ gc: false });
        model.insertBlocks(toDocHandle(doc), null, codec.parse(markdown));
        return doc;
      };
      const coordinator = createBranchCoordinator({ store });
      const emptyA = createCollabYDoc({ gc: false });
      const emptyB = createCollabYDoc({ gc: false });
      const branchA = await store.ensureWorkDraftBranch({
        documentId: CREATED_A as never,
        workId: WORK_ID as never,
        liveDoc: emptyA,
      });
      const branchB = await store.ensureWorkDraftBranch({
        documentId: CREATED_B as never,
        workId: WORK_ID as never,
        liveDoc: emptyB,
      });
      const contentA = docFromMarkdown("Created A content.");
      const contentB = docFromMarkdown("Created B content.");
      await coordinator.commitUpdate({
        branchId: branchA.branchId,
        updateData: Y.encodeStateAsUpdate(contentA),
        source: "agent",
        threadId: THREAD_ID as never,
      });
      await coordinator.commitUpdate({
        branchId: branchB.branchId,
        updateData: Y.encodeStateAsUpdate(contentB),
        source: "agent",
        threadId: THREAD_ID as never,
      });
      await store.recordManifestDocumentCreated(CREATED_A as never, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });
      await store.recordManifestDocumentCreated(CREATED_B as never, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });
      const manifest = await store.ensureProjectManifest({ projectId: PROJECT_ID as never });
      const manifestBranch = await store.resolveWorkDraftBranchForWork({
        documentId: manifest.documentId,
        workId: WORK_ID as never,
        liveDoc: manifest.doc,
      });
      const realChangeTrails = createDrizzleChangeTrailAggregateWriter(db);
      let trailRecordCalls = 0;
      let failSecondTrailRecord = true;
      const failingChangeTrails = {
        async record(input: Parameters<typeof realChangeTrails.record>[0]) {
          trailRecordCalls += 1;
          if (failSecondTrailRecord && trailRecordCalls === 2) {
            throw new Error("injected companion trail failure");
          }
          return realChangeTrails.record(input);
        },
        replacePushContribution: (
          pushId: Parameters<typeof realChangeTrails.replacePushContribution>[0],
          replacement: Parameters<typeof realChangeTrails.replacePushContribution>[1],
          context: Parameters<typeof realChangeTrails.replacePushContribution>[2],
        ) => realChangeTrails.replacePushContribution(pushId, replacement, context),
        reopenOwners: (owners: Parameters<typeof realChangeTrails.reopenOwners>[0]) =>
          realChangeTrails.reopenOwners(owners),
      };
      const branchPush = createBranchPushService({
        assetPaths: NO_DOCUMENT_ASSET_PATHS,
        changeEventDelivery: { deliver() {} },
        branchStore: store,
        ...createPushStores(markdownProjectionSerializer(model, codec), failingChangeTrails),
        branchCoordinator: coordinator,
        journal: livePersistence.journal,
        liveCoordinator,
        model,
        codec,
      });

      const [contentARow] = await db
        .select()
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, branchA.branchId));
      if (!contentARow) throw new Error("missing content A row");
      await db
        .update(branchWriteJournal)
        .set({ turnId: TURN_ID as never })
        .where(eq(branchWriteJournal.status, "active"));
      const pushInput = {
        branchId: branchA.branchId,
        manifestBranchId: manifestBranch.branchId,
        manifestEntryDocumentId: CREATED_A as never,
        pushedByUserId: USER_ID as never,
      };
      await expect(branchPush.pushToLiveWithManifestEntry(pushInput)).rejects.toThrow(
        "injected companion trail failure",
      );
      expect(await db.select().from(pushLineage)).toEqual([]);
      expect(await db.select().from(changeTrailShells)).toEqual([]);
      expect(await db.select().from(changeTrailDocumentDetails)).toEqual([]);
      expect(await db.select().from(changeTrailDeliveryOutbox)).toEqual([]);
      expect(
        (await db.select().from(branchWriteJournal)).filter((row) => row.status === "pushed"),
      ).toEqual([]);

      failSecondTrailRecord = false;
      trailRecordCalls = 0;
      const pushed = await branchPush.pushToLiveWithManifestEntry(pushInput);
      const liveView = await store.resolveManifestMembership({ projectId: PROJECT_ID as never });
      const lineageRows = await db.select().from(pushLineage);
      const activeManifestRows = await db
        .select()
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, manifestBranch.branchId));
      const snapshotA = await livePersistence.journal.read(CREATED_A as never);
      const liveA = createCollabYDoc({ gc: false });
      if (snapshotA.checkpoint) Y.applyUpdate(liveA, snapshotA.checkpoint);
      for (const update of snapshotA.updates) Y.applyUpdate(liveA, update.update);

      expect(pushed.status).toBe("pushed");
      expect(liveView.members).toContain(CREATED_A);
      expect(liveView.members).not.toContain(CREATED_B);
      expect(codec.serialize(model.projectBlocks(toDocHandle(liveA)))).toContain(
        "Created A content.",
      );
      expect(lineageRows).toHaveLength(2);
      expect(new Set(lineageRows.map((row) => row.receiptId))).toHaveLength(1);
      const trailDetails = await db.select().from(changeTrailDocumentDetails);
      const trailReceiptIds = trailDetails.flatMap((detail) =>
        (detail.changes as Array<{ receiptId: string }>).map((change) => change.receiptId),
      );
      expect(trailDetails).toHaveLength(1);
      expect(new Set(trailReceiptIds)).toEqual(new Set([lineageRows[0]?.receiptId]));
      expect(activeManifestRows.filter((row) => row.status === "active")).toHaveLength(1);
      const [reviewedContentRow] = await db
        .select({
          reviewedBy: branchWriteJournal.reviewedBy,
          reviewedAt: branchWriteJournal.reviewedAt,
        })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.id, contentARow.id));
      expect(reviewedContentRow?.reviewedBy).toBe(USER_ID);
      expect(reviewedContentRow?.reviewedAt).toBeInstanceOf(Date);

      const contentA2 = docFromMarkdown("Created A content.\n\nSecond A content.");
      await coordinator.commitUpdate({
        branchId: branchA.branchId,
        updateData: Y.encodeStateAsUpdate(contentA2),
        source: "agent",
        threadId: THREAD_ID as never,
      });
      await expect(
        branchPush.pushToLiveWithManifestEntry({
          branchId: branchA.branchId,
          manifestBranchId: manifestBranch.branchId,
          manifestEntryDocumentId: CREATED_A as never,
          pushedByUserId: USER_ID as never,
        }),
      ).resolves.toMatchObject({ status: "pushed" });
      await expect(db.select().from(pushLineage)).resolves.toHaveLength(3);

      manifestBranch.doc.destroy();
      manifest.doc.destroy();
    });

    it("commitPush rejects stale branch snapshots and non-active source rows", async () => {
      const pushStore = createDrizzlePushCommitStore(
        db,
        stagePendingSettlementWithinTx,
        createDrizzleChangeTrailAggregateWriter(db),
      );
      const journalReadStore = createDrizzleBranchJournalReadStore(db);
      const branch = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
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

      await db
        .update(documentBranches)
        .set({ state: Buffer.from(Y.encodeStateAsUpdate(docWithText("concurrent"))) })
        .where(eq(documentBranches.id, branch.branchId));
      await expect(
        pushStore.commitPush({
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
          pendingLiveSettlement: {
            documentTitle: "document",
            lockCutUpdate: Y.encodeStateAsUpdate(branchDoc),
            pushUpdate: update,
            postCutUpdates: [],
            sweepEvidence: null,
            joinVersion: 0,
            settledJoinVersion: null,
            claim: {
              token: "00000000-0000-4000-8000-000000000699",
              epoch: 1,
              kind: "warm",
              leaseExpiresAt: new Date(Date.now() + 30_000),
            },
            attemptCount: 0,
            state: "pending",
            trail: {
              documentId: DOC_ID,
              documentTitle: "document",
              receiptId: "receipt",
              threadIds: [],
              journalOwners: [],
              changes: [],
            },
          },
        }),
      ).rejects.toThrow("changed before its push could commit");
      await expect(db.select().from(pushLineage)).resolves.toHaveLength(0);

      const fresh = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
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
        pushStore.commitPush({
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
          pendingLiveSettlement: {
            documentTitle: "document",
            lockCutUpdate: Y.encodeStateAsUpdate(branchDoc),
            pushUpdate: update,
            postCutUpdates: [],
            sweepEvidence: null,
            joinVersion: 0,
            settledJoinVersion: null,
            claim: {
              token: "00000000-0000-4000-8000-000000000699",
              epoch: 1,
              kind: "warm",
              leaseExpiresAt: new Date(Date.now() + 30_000),
            },
            attemptCount: 0,
            state: "pending",
            trail: {
              documentId: DOC_ID,
              documentTitle: "document",
              receiptId: "receipt",
              threadIds: [],
              journalOwners: [],
              changes: [],
            },
          },
        }),
      ).rejects.toThrow("changed before its push could commit");
      await expect(db.select().from(pushLineage)).resolves.toHaveLength(0);
    });

    it("G2 §6.1 entry corrupt snapshot fails loudly at branch-room load", async () => {
      const { BranchCorruptError } = await import("../../domain/branch-resolver.js");
      await db.insert(documentBranches).values({
        id: "branch_corrupt_review_entry",
        documentId: DOC_ID as never,
        kind: "work_draft",
        upstreamBranchId: null,
        workId: WORK_ID as never,
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

    it("G2 §6.1 corrupt recovery resets from live without decoding the corrupt snapshot", async () => {
      await db.insert(documentBranches).values({
        id: "branch_corrupt_preview_reset",
        documentId: DOC_ID as never,
        kind: "work_draft",
        upstreamBranchId: null,
        workId: WORK_ID as never,
        threadId: null,
        status: "active",
        state: Buffer.from([1, 2]),
        stateVector: Buffer.from([0]),
        schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
      });
      const coordinator = createBranchCoordinator({ store });

      await expect(
        coordinator.resetFromDoc("branch_corrupt_preview_reset", docWithText("live repair")),
      ).resolves.toBeUndefined();

      const repaired = await store.resolveWorkDraftBranchForWork({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: docWithText("ignored"),
      });
      expect(repaired.branchId).toBe("branch_corrupt_preview_reset");
      expect(repaired.generation).toBeGreaterThan(0);
      expect(repaired.doc.getText("content").toString()).toBe("live repair");
    });

    it("G2 §6.1 entry mid-reset rebinds to the bumped generation branch room", async () => {
      const coordinator = createBranchCoordinator({ store });
      const branch = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: docWithText("before reset"),
      });
      await coordinator.resetFromDoc(branch.branchId, docWithText("after reset"));
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
      const branch = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
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
    it("rejects branch journal writes whose generation does not match the snapshot CAS generation", async () => {
      const branch = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: docWithText("seed"),
      });
      const changed = docWithText("changed");
      const updateData = Y.encodeStateAsUpdate(changed);
      const committed = await store.commitBranchMutation?.({
        branchId: branch.branchId,
        expectedGeneration: branch.generation,
        expectedStateVector: branch.stateVector,
        expectedState: branch.state,
        state: updateData,
        stateVector: Y.encodeStateVector(changed),
        journal: {
          branchId: branch.branchId,
          generation: branch.generation + 1,
          updateData,
          source: "agent",
        },
      });
      const reloaded = await store.getBranch(branch.branchId);
      const journalRows = await db
        .select({ id: branchWriteJournal.id })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, branch.branchId));

      expect(committed).toBe(false);
      expect(reloaded?.generation).toBe(branch.generation);
      expect(journalRows).toEqual([]);
    });

    it("rejects a staged reversal after Apply changes the planned row status", async () => {
      const branch = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
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
        expectedGeneration: branch.generation,
        expectedStateVector: branch.stateVector,
        expectedState: branch.state,
        state: Y.encodeStateAsUpdate(changed),
        stateVector: Y.encodeStateVector(changed),
        journal: {
          branchId: branch.branchId,
          generation: branch.generation,
          expectedJournalWatermark: planned.id,
          expectedJournalRevision: `${planned.id}:active`,
          updateData: Y.encodeStateAsUpdate(changed),
          source: "agent",
        },
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
