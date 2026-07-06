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
      documentYjsHeads,
      documentYjsUpdates,
      documents,
      projects,
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
    const { createBranchCoordinator } = await import("../../domain/branch-coordinator.js");
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
    const store = createDrizzleBranchStore(db);

    function docWithText(value: string): Y.Doc {
      const doc = new Y.Doc({ gc: false });
      doc.getText("content").insert(0, value);
      return doc;
    }

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        branchWriteJournal,
        documentBranches,
        documentYjsHeads,
        threadWorks,
        threads,
        documents,
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
      const before = await store.syncManifestToDocuments(PROJECT_ID as never);
      expect(before.members).toEqual([DOC_ID]);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, DOC_ID));

      const reloaded = createDrizzleBranchStore(db);
      const after = await reloaded.syncManifestToDocuments(PROJECT_ID as never);
      expect(after.members).toEqual([DOC_ID]);
    });

    it("records manifest membership mutations as journaled live peer writes", async () => {
      const before = await store.syncManifestToDocuments(PROJECT_ID as never);
      await store.recordManifestDocumentDeleted(DOC_ID as never);
      const after = await store.syncManifestToDocuments(PROJECT_ID as never);
      const updates = await db
        .select({ id: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, before.documentId));

      expect(after.members).toEqual([]);
      expect(updates).toHaveLength(1);
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
