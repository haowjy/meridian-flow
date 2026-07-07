/** Adapter-contract tests for Drizzle branch peers against local Postgres. */
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle branch store (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle branch store adapter contract (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const dbSchema = await import("@meridian/database/schema");
    const {
      branchWriteJournal,
      contextSources,
      documentBranches,
      documentYjsCheckpoints,
      documentYjsHeads,
      documentYjsUpdates,
      documents,
      projects,
      pushLineage,
      threadWorks,
      threads,
      users,
      works,
    } = dbSchema;
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleBranchStore } = await import("../drizzle-branches.js");
    const { createDrizzleBranchPushStore } = await import("../drizzle-branch-push.js");
    const { createDrizzleCollabPersistence } = await import("../drizzle-journal.js");
    const { createCollabYDoc } = await import("@meridian/prosemirror-schema");
    const { createBranchCoordinator, BranchStaleUpdateError } = await import(
      "../../domain/branch-coordinator.js"
    );
    const { createBranchPushService } = await import("../../domain/branch-push.js");
    const { mdxCodec } = await import("@meridian/markup");
    const { toDocHandle, yProsemirrorModel } = await import("@meridian/agent-edit");
    const { buildDocumentSchema } = await import("@meridian/prosemirror-schema");
    const { DrizzleContextDocumentStore } = await import(
      "../../../context/adapters/context-fs/drizzle-store.js"
    );
    const { createDrizzleDocumentAccess } = await import("../../../../lib/document-access.js");
    const { resolveDocumentUri } = await import("../../../context/document-uri-resolver.js");
    const { StaleDocumentSchemaError } = await import("../../domain/stale-schema.js");
    const { COLLAB_SCHEMA_VERSION } = await import("@meridian/prosemirror-schema");

    const USER_ID = "00000000-0000-4000-8000-000000000601";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000602";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000603";
    const WORK_ID = "00000000-0000-4000-8000-000000000604";
    const DOC_ID = "00000000-0000-4000-8000-000000000605";
    const THREAD_ID = "00000000-0000-4000-8000-000000000606";

    const db = createDb(DATABASE_URL, { max: 4 });
    const livePersistence = createDrizzleCollabPersistence(db);
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
    const store = createDrizzleBranchStore(db, {
      journal: livePersistence.journal,
      lifecycle: livePersistence.lifecycle,
      coordinator: liveCoordinator,
    });

    function docWithText(value: string): Y.Doc {
      const doc = new Y.Doc({ gc: false });
      doc.getText("content").insert(0, value);
      return doc;
    }

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        branchWriteJournal,
        documentBranches,
        documentYjsCheckpoints,
        documentYjsHeads,
        threadWorks,
        threads,
        documents,
        pushLineage,
        contextSources,
        works,
        projects,
        users,
      ]);
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
        title: "Branch Work",
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
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread",
        kind: "primary",
        status: "active",
      });
      await db
        .insert(threadWorks)
        .values({ threadId: THREAD_ID, workId: WORK_ID, projectId: PROJECT_ID, isPrimary: true });
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it("provisions work draft from live and thread peer from work draft, never empty", async () => {
      const live = docWithText("existing upstream prose");
      await store.ensureThreadPeerBranch({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        liveDoc: live,
      });

      const resolved = await store.resolveThreadBranch(DOC_ID as never, THREAD_ID as never);
      expect(resolved.doc.getText("content").toString()).toBe("existing upstream prose");
    });

    it("seeds work-draft push policy from the work write mode", async () => {
      const directWork = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: docWithText("direct mode"),
      });
      expect(directWork.pushPolicy).toBe("auto");

      await db.delete(documentBranches).where(eq(documentBranches.id, directWork.branchId));
      await db.update(works).set({ aiWriteMode: "draft" }).where(eq(works.id, WORK_ID));

      const draftWork = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: docWithText("draft mode"),
      });
      expect(draftWork.pushPolicy).toBe("manual");
    });

    it("stamps branch rows from the live head and checks the row schema on resolve", async () => {
      const staleVersion = COLLAB_SCHEMA_VERSION - 1;
      await db.insert(documentYjsHeads).values({
        documentId: DOC_ID as never,
        schemaVersion: staleVersion,
      });
      const work = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: docWithText("seeded under stale schema"),
      });
      expect(work.schemaVersion).toBe(staleVersion);

      await db
        .update(documentYjsHeads)
        .set({ schemaVersion: COLLAB_SCHEMA_VERSION })
        .where(eq(documentYjsHeads.documentId, DOC_ID as never));
      const peerDoc = docWithText("stale peer snapshot");
      await db.insert(documentBranches).values({
        id: "branch_stale_peer",
        documentId: DOC_ID as never,
        kind: "thread_peer",
        upstreamBranchId: work.branchId,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
        pushPolicy: "manual",
        status: "active",
        state: Buffer.from(Y.encodeStateAsUpdate(peerDoc)),
        stateVector: Buffer.from(Y.encodeStateVector(peerDoc)),
        schemaVersion: staleVersion,
      });

      await expect(store.resolveThreadBranch(DOC_ID as never, THREAD_ID as never)).rejects.toThrow(
        StaleDocumentSchemaError,
      );
    });

    it("persists live->work and work->thread pulls", async () => {
      const live = docWithText("live prose");
      const work = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: new Y.Doc({ gc: false }),
      });
      const peer = await store.ensureThreadPeerBranch({
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        liveDoc: new Y.Doc({ gc: false }),
      });
      const coordinator = createBranchCoordinator({ store });

      await coordinator.pullFromDoc(work.branchId, live);
      await coordinator.pullFromBranch(peer.branchId);

      const resolved = await store.resolveThreadBranch(DOC_ID as never, THREAD_ID as never);
      expect(Y.encodeStateAsUpdate(resolved.doc)).toEqual(Y.encodeStateAsUpdate(live));
    });

    it("discard/reset marks old-generation rows discarded and unpushed counts join the active generation", async () => {
      const live = docWithText("live base");
      const work = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: live,
      });
      const coordinator = createBranchCoordinator({ store });
      const draft = docWithText("draft row before discard");
      await coordinator.commitUpdate({
        branchId: work.branchId,
        updateData: Y.encodeStateAsUpdate(draft),
        source: "agent",
        threadId: THREAD_ID as never,
      });
      const pushStore = createDrizzleBranchPushStore(db);
      await expect(pushStore.countUnpushedRowsForWork(WORK_ID as never)).resolves.toBe(1);

      await coordinator.resetFromDoc(work.branchId, live);

      await expect(pushStore.countUnpushedRowsForWork(WORK_ID as never)).resolves.toBe(0);
      const rows = await db
        .select({ generation: branchWriteJournal.generation, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.branchId, work.branchId));
      expect(rows).toEqual([{ generation: work.generation, status: "discarded" }]);
    });

    it("rejects stale branch-room updates against the generation loaded by the room", async () => {
      const live = docWithText("room base");
      const work = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: live,
      });
      const coordinator = createBranchCoordinator({ store });
      const staleRoom = docWithText("stale branch room write");

      await coordinator.resetFromDoc(work.branchId, live);
      await expect(
        coordinator.commitUpdate({
          branchId: work.branchId,
          expectedGeneration: work.generation,
          updateData: Y.encodeStateAsUpdate(staleRoom),
          source: "writer",
          actorUserId: USER_ID as never,
        }),
      ).rejects.toThrow(BranchStaleUpdateError);
      await expect(
        coordinator.readBranch(work.branchId, async (doc) => doc.getText("content").toString()),
      ).resolves.toBe("room base");

      const fresh = await store.getBranch(work.branchId);
      const freshRoom = docWithText("fresh branch room write");
      await coordinator.commitUpdate({
        branchId: work.branchId,
        expectedGeneration: fresh?.generation,
        updateData: Y.encodeStateAsUpdate(freshRoom),
        source: "writer",
        actorUserId: USER_ID as never,
      });
      const freshText = await coordinator.readBranch(work.branchId, async (doc) =>
        doc.getText("content").toString(),
      );
      expect(freshText).toContain("room base");
      expect(freshText).toContain("fresh branch room write");
    });

    it("keeps manifest identity rows invisible to content surfaces", async () => {
      const manifest = await store.ensureProjectManifest({ projectId: PROJECT_ID as never });
      await db
        .update(documents)
        .set({ markdownProjection: "manifest-only secret" })
        .where(eq(documents.id, manifest.documentId));
      const contentStore = new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID });
      const access = createDrizzleDocumentAccess(db);

      await expect(contentStore.findDocument(null, ".manifest", "json")).resolves.toBeNull();
      await expect(contentStore.listDocuments(null)).resolves.toEqual([
        expect.objectContaining({ id: DOC_ID }),
      ]);
      await expect(resolveDocumentUri(db, manifest.documentId)).resolves.toBeNull();
      await expect(
        contentStore.upsertDocument({
          id: "00000000-0000-4000-8000-000000000607" as never,
          folderId: null,
          name: ".manifest",
          extension: "json",
          markdown: "writer visible namesake",
          filetype: "json",
        }),
      ).resolves.toEqual(expect.objectContaining({ name: ".manifest", extension: "json" }));
      await expect(access.canAccessDocument(USER_ID as never, manifest.documentId)).resolves.toBe(
        false,
      );
      await expect(
        access.canAccessProjectDocument(USER_ID as never, manifest.documentId, PROJECT_ID as never),
      ).resolves.toBe(false);
    });

    it("persists manifest membership as a live Yjs peer across store reload", async () => {
      const before = await store.resolveManifestMembership({ projectId: PROJECT_ID as never });
      expect(before.members).toEqual([DOC_ID]);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, DOC_ID));

      const reloaded = createDrizzleBranchStore(db, {
        journal: livePersistence.journal,
        lifecycle: livePersistence.lifecycle,
        coordinator: liveCoordinator,
      });
      const after = await reloaded.resolveManifestMembership({ projectId: PROJECT_ID as never });
      expect(after.members).toEqual([DOC_ID]);
    });

    it("routes thread manifest membership mutations through branch journal, not the live manifest", async () => {
      const before = await store.resolveManifestMembership({ projectId: PROJECT_ID as never });
      const beforeUpdates = await db
        .select({ id: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, before.documentId));

      await store.recordManifestDocumentDeleted(DOC_ID as never, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });

      const threadView = await store.resolveManifestMembership({
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });
      const liveView = await store.resolveManifestMembership({ projectId: PROJECT_ID as never });
      const updates = await db
        .select({ id: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, before.documentId));
      const branchRows = await db
        .select({ id: branchWriteJournal.id })
        .from(branchWriteJournal)
        .innerJoin(documentBranches, eq(branchWriteJournal.branchId, documentBranches.id))
        .where(eq(documentBranches.documentId, before.documentId));

      expect(threadView.members).toEqual([]);
      expect(liveView.members).toEqual([DOC_ID]);
      expect(updates).toHaveLength(beforeUpdates.length);
      expect(branchRows).toHaveLength(1);
    });

    it("keeps a first draft-created document out of the live manifest when seeding", async () => {
      const createdId = "00000000-0000-4000-8000-000000000609";
      await db.insert(documents).values({
        id: createdId as never,
        contextSourceId: SOURCE_ID,
        name: "manual-created",
        extension: "md",
        fileType: "markdown",
      });

      await store.recordManifestDocumentCreated(createdId as never, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });

      await expect(
        store.resolveManifestMembership({ projectId: PROJECT_ID as never }),
      ).resolves.toMatchObject({ members: [DOC_ID] });
      await expect(
        store.resolveManifestMembership({
          projectId: PROJECT_ID as never,
          workId: WORK_ID as never,
          threadId: THREAD_ID as never,
        }),
      ).resolves.toMatchObject({ members: [DOC_ID, createdId] });
    });

    it("keeps existing live documents visible when they have active work-draft branches during manifest seed", async () => {
      await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: docWithText("existing live chapter"),
      });

      await expect(
        store.resolveManifestMembership({ projectId: PROJECT_ID as never }),
      ).resolves.toMatchObject({ members: [DOC_ID] });
    });

    it("keeps compacted live documents visible when seeding despite zero live update rows", async () => {
      const live = docWithText("compacted live chapter");
      const [checkpoint] = await db
        .insert(documentYjsCheckpoints)
        .values({
          documentId: DOC_ID as never,
          state: Buffer.from(Y.encodeStateAsUpdate(live)),
          stateVector: Buffer.from(Y.encodeStateVector(live)),
          upToSeq: 1,
          reason: "test-compaction",
        })
        .returning({ id: documentYjsCheckpoints.id });
      await db.insert(documentYjsHeads).values({
        documentId: DOC_ID as never,
        schemaVersion: COLLAB_SCHEMA_VERSION,
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

    it("keeps live manifest writes direct for writer/project context", async () => {
      const before = await store.resolveManifestMembership({ projectId: PROJECT_ID as never });
      const beforeUpdates = await db
        .select({ id: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, before.documentId));

      await store.recordManifestDocumentDeleted(DOC_ID as never);

      const after = await store.resolveManifestMembership({ projectId: PROJECT_ID as never });
      const updates = await db
        .select({ id: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, before.documentId));
      expect(after.members).toEqual([]);
      expect(updates).toHaveLength(beforeUpdates.length + 1);
    });

    it("provisions manifest work/thread branches through standard branch ensure and pull machinery", async () => {
      const manifest = await store.resolveManifestMembership({
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });
      const branchRows = await db
        .select({
          id: documentBranches.id,
          kind: documentBranches.kind,
          upstreamBranchId: documentBranches.upstreamBranchId,
          workId: documentBranches.workId,
          threadId: documentBranches.threadId,
        })
        .from(documentBranches)
        .where(eq(documentBranches.documentId, manifest.documentId));

      const work = branchRows.find((row) => row.kind === "work_draft");
      const peer = branchRows.find((row) => row.kind === "thread_peer");
      expect(work).toEqual(expect.objectContaining({ workId: WORK_ID, threadId: null }));
      expect(peer).toEqual(
        expect.objectContaining({
          workId: WORK_ID,
          threadId: THREAD_ID,
          upstreamBranchId: work?.id,
        }),
      );
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

    it("pushes manifest membership journal rows with lineage receipt", async () => {
      await store.recordManifestDocumentDeleted(DOC_ID as never, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });
      const manifest = await store.ensureProjectManifest({ projectId: PROJECT_ID as never });
      const work = await store.ensureWorkDraftBranch({
        documentId: manifest.documentId,
        workId: WORK_ID as never,
        liveDoc: manifest.doc,
      });
      const schema = buildDocumentSchema();
      const branchPush = createBranchPushService({
        branchStore: store,
        pushStore: createDrizzleBranchPushStore(db, {
          model: yProsemirrorModel(schema),
          codec: mdxCodec({ schema }),
        }),
        branchCoordinator: createBranchCoordinator({ store }),
        journal: livePersistence.journal,
        liveCoordinator,
        model: yProsemirrorModel(schema),
        codec: mdxCodec({ schema }),
      });

      const pushed = await branchPush.pushToLive({ branchId: work.branchId });
      const liveView = await store.resolveManifestMembership({ projectId: PROJECT_ID as never });

      expect(pushed.status).toBe("pushed");
      if (pushed.status !== "pushed") throw new Error(`Unexpected push status: ${pushed.status}`);
      expect(pushed.push.documentId).toBe(manifest.documentId);
      expect(pushed.push.journalIds).toHaveLength(1);
      expect(liveView.members).toEqual([]);
      manifest.doc.destroy();
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
      const codec = mdxCodec({ schema });
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
      const branchPush = createBranchPushService({
        branchStore: store,
        pushStore: createDrizzleBranchPushStore(db, { model, codec }),
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
      const pushed = await branchPush.pushToLiveWithManifestEntry({
        branchId: branchA.branchId,
        manifestBranchId: manifestBranch.branchId,
        manifestEntryDocumentId: CREATED_A as never,
        contentJournalIds: [Number(contentARow.id)],
        pushedByUserId: USER_ID as never,
      });
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
      expect(lineageRows.map((row) => row.pushKind).sort()).toEqual(["selective", "selective"]);
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
      const schema = buildDocumentSchema();
      const pushStore = createDrizzleBranchPushStore(db, {
        model: yProsemirrorModel(schema),
        codec: mdxCodec({ schema }),
      });
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
              status: "active",
            },
          ],
          pushUpdate: update,
          receiptPayload: {
            version: 1,
            documentId: DOC_ID as never,
            branchId: branch.branchId,
            branchGeneration: branch.generation,
            pushKind: "whole",
            changedBlocks: [],
            totalWordDelta: 0,
          },
          idempotencyKey: "stale-branch",
          markdownProjection: "draft",
          liveStateVector: Y.encodeStateVector(branchDoc),
          liveState: Y.encodeStateAsUpdate(branchDoc),
        }),
      ).rejects.toThrow("changed before its push could commit");
      await expect(db.select().from(pushLineage)).resolves.toHaveLength(0);

      const fresh = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: docWithText("live"),
      });
      const freshRows = await pushStore.listActiveJournalRows(fresh.branchId, fresh.generation);
      await db
        .update(branchWriteJournal)
        .set({ status: "discarded" })
        .where(eq(branchWriteJournal.id, journalRow.id));
      await expect(
        pushStore.commitPush({
          branch: fresh,
          journalRows: freshRows,
          pushUpdate: update,
          receiptPayload: {
            version: 1,
            documentId: DOC_ID as never,
            branchId: fresh.branchId,
            branchGeneration: fresh.generation,
            pushKind: "whole",
            changedBlocks: [],
            totalWordDelta: 0,
          },
          idempotencyKey: "inactive-row",
          markdownProjection: "draft",
          liveStateVector: Y.encodeStateVector(branchDoc),
          liveState: Y.encodeStateAsUpdate(branchDoc),
        }),
      ).rejects.toThrow("changed before its push could commit");
      await expect(db.select().from(pushLineage)).resolves.toHaveLength(0);
    });

    it("G2 §6.1 entry success: missing work-draft row is created and branch room loads that branch", async () => {
      const { branchRoomName } = await import("@meridian/contracts/protocol");
      const { createHocuspocusPersistenceService } = await import(
        "../../hocuspocus-persistence.js"
      );
      const live = docWithText("live review seed");
      const branch = await store.resolveWorkDraftBranchForWork({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: live,
      });
      const coordinator = createBranchCoordinator({ store });
      const persistence = createHocuspocusPersistenceService({
        journal: livePersistence.journal,
        branchStore: store,
        branchCoordinator: coordinator,
        hocuspocus: () => null,
        metaForOrigin: () => ({ origin: "system", seq: 0 }),
        latestUpdateSeq: async () => 0,
        emitAgentEditInvariantViolation: () => undefined,
      });

      const room = await persistence.resolveBranchHocuspocusRoom(
        branch.branchId,
        branch.generation,
      );
      const loaded = (
        await persistence.loadHocuspocusBranchState(branch.branchId, branch.generation)
      )?.state;
      const loadedDoc = new Y.Doc({ gc: false });
      if (loaded) Y.applyUpdate(loadedDoc, loaded);

      expect(branchRoomName(branch.branchId, branch.generation)).toBe(
        `branch:${branch.branchId}:gen:${branch.generation}`,
      );
      expect(room).toMatchObject({ branchId: branch.branchId, documentId: DOC_ID });
      expect(loadedDoc.getText("content").toString()).toBe("live review seed");
    });

    it("lists concurrent journal rows by the production document/generation/floor predicate", async () => {
      const pushStore = createDrizzleBranchPushStore(db);
      const update = Buffer.from(Y.encodeStateAsUpdate(docWithText("row")));
      const otherDocId = "00000000-0000-4000-8000-000000000612";
      await db.insert(documents).values({
        id: otherDocId as never,
        contextSourceId: SOURCE_ID,
        name: "other-chapter",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(documentBranches).values([
        {
          id: "branch_target_floor",
          documentId: DOC_ID as never,
          kind: "work_draft",
          upstreamBranchId: null,
          workId: WORK_ID as never,
          threadId: null,
          pushPolicy: "manual",
          status: "active",
          state: update,
          stateVector: Buffer.from(Y.encodeStateVector(docWithText("target"))),
          schemaVersion: COLLAB_SCHEMA_VERSION,
          generation: 1,
        },
        {
          id: "branch_other_pushed",
          documentId: DOC_ID as never,
          kind: "thread_peer",
          upstreamBranchId: "branch_target_floor",
          workId: WORK_ID as never,
          threadId: THREAD_ID as never,
          pushPolicy: "manual",
          status: "active",
          state: update,
          stateVector: Buffer.from(Y.encodeStateVector(docWithText("other"))),
          schemaVersion: COLLAB_SCHEMA_VERSION,
          generation: 2,
        },
        {
          id: "branch_other_document",
          documentId: otherDocId as never,
          kind: "work_draft",
          upstreamBranchId: null,
          workId: WORK_ID as never,
          threadId: null,
          pushPolicy: "manual",
          status: "active",
          state: update,
          stateVector: Buffer.from(Y.encodeStateVector(docWithText("other doc"))),
          schemaVersion: COLLAB_SCHEMA_VERSION,
          generation: 1,
        },
      ]);
      await db.insert(branchWriteJournal).values([
        {
          id: 9,
          branchId: "branch_other_pushed",
          generation: 1,
          updateData: update,
          status: "pushed",
        },
        {
          id: 10,
          branchId: "branch_target_floor",
          generation: 1,
          updateData: update,
          status: "active",
        },
        {
          id: 11,
          branchId: "branch_other_pushed",
          generation: 2,
          updateData: update,
          status: "pushed",
        },
        {
          id: 12,
          branchId: "branch_other_pushed",
          generation: 1,
          updateData: update,
          status: "discarded",
        },
        {
          id: 13,
          branchId: "branch_other_pushed",
          generation: 3,
          updateData: update,
          status: "pushed",
        },
        {
          id: 14,
          branchId: "branch_other_document",
          generation: 1,
          updateData: update,
          status: "pushed",
        },
      ]);

      const rows = await pushStore.listConcurrentJournalRows("branch_target_floor", 1, {
        documentId: DOC_ID as never,
        afterJournalId: 9,
      });

      expect(rows.map((row) => row.id)).toEqual([10, 11]);
    });

    it("G2 §6.1 entry corrupt snapshot fails loudly at branch-room load", async () => {
      const { createHocuspocusPersistenceService } = await import(
        "../../hocuspocus-persistence.js"
      );
      const { BranchCorruptError } = await import("../../domain/branch-resolver.js");
      await db.insert(documentBranches).values({
        id: "branch_corrupt_review_entry",
        documentId: DOC_ID as never,
        kind: "work_draft",
        upstreamBranchId: null,
        workId: WORK_ID as never,
        threadId: null,
        pushPolicy: "manual",
        status: "active",
        state: Buffer.from([1, 2]),
        stateVector: Buffer.from([0]),
        schemaVersion: COLLAB_SCHEMA_VERSION,
      });
      const persistence = createHocuspocusPersistenceService({
        journal: livePersistence.journal,
        branchStore: store,
        branchCoordinator: createBranchCoordinator({ store }),
        hocuspocus: () => null,
        metaForOrigin: () => ({ origin: "system", seq: 0 }),
        latestUpdateSeq: async () => 0,
        emitAgentEditInvariantViolation: () => undefined,
      });

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
        pushPolicy: "manual",
        status: "active",
        state: Buffer.from([1, 2]),
        stateVector: Buffer.from([0]),
        schemaVersion: COLLAB_SCHEMA_VERSION,
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
      const { createHocuspocusPersistenceService } = await import(
        "../../hocuspocus-persistence.js"
      );
      const coordinator = createBranchCoordinator({ store });
      const branch = await store.ensureWorkDraftBranch({
        documentId: DOC_ID as never,
        workId: WORK_ID as never,
        liveDoc: docWithText("before reset"),
      });
      await coordinator.resetFromDoc(branch.branchId, docWithText("after reset"));
      const persistence = createHocuspocusPersistenceService({
        journal: livePersistence.journal,
        branchStore: store,
        branchCoordinator: coordinator,
        hocuspocus: () => null,
        metaForOrigin: () => ({ origin: "system", seq: 0 }),
        latestUpdateSeq: async () => 0,
        emitAgentEditInvariantViolation: () => undefined,
      });

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
      const { createHocuspocusPersistenceService } = await import(
        "../../hocuspocus-persistence.js"
      );
      const persistence = createHocuspocusPersistenceService({
        journal: livePersistence.journal,
        branchStore: store,
        branchCoordinator: createBranchCoordinator({ store }),
        hocuspocus: () => null,
        metaForOrigin: () => ({ origin: "system", seq: 0 }),
        latestUpdateSeq: async () => 0,
        emitAgentEditInvariantViolation: () => undefined,
      });

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
  });
}
