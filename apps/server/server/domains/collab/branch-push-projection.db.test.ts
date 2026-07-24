/** PostgreSQL regression coverage for filetype-aware branch-push projections. */
import { randomUUID } from "node:crypto";
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  branchPushSettlementOutbox,
  contextSources,
  documents,
  documentYjsUpdates,
  projects,
  threads,
  threadWorks,
  turns,
  users,
  works,
} from "@meridian/database/schema";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createDrizzleBranchJournalReadStore,
  createDrizzlePushCommitStore,
  createDrizzleWorkPushPolicyStore,
} from "./adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "./adapters/drizzle-branches.js";
import { createDrizzleChangeTrailPersistence } from "./adapters/drizzle-change-trails.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import {
  createDrizzlePendingSettlementStore,
  stagePendingSettlementWithinTx,
} from "./adapters/drizzle-pending-settlement.js";
import { createBranchCoordinator } from "./domain/branch-coordinator.js";
import { createBranchPushService } from "./domain/branch-push.js";
import { createMarkdownDocumentEngine } from "./domain/markdown-document.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DB suites require DATABASE_URL");

describe("branch-push durable projection", () => {
  const db = createDb(DATABASE_URL, { max: 4 });
  const persistence = createDrizzleCollabPersistence(db);
  const liveDocs = new Map<string, Y.Doc>();
  const liveCoordinator = {
    async withDocument<T>(documentId: string, fn: (doc: Y.Doc) => T | Promise<T>): Promise<T> {
      let doc = liveDocs.get(documentId);
      if (!doc) {
        doc = createCollabYDoc({ gc: false });
        const snapshot = await persistence.journal.read(documentId);
        if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
        for (const update of snapshot.updates) Y.applyUpdate(doc, update.update);
        liveDocs.set(documentId, doc);
      }
      return fn(doc);
    },
    async recover() {},
  };
  const branchStore = createDrizzleBranchStore(db, {
    journal: persistence.journal,
    lifecycle: persistence.lifecycle,
    coordinator: liveCoordinator,
  });

  afterAll(async () => {
    for (const doc of liveDocs.values()) doc.destroy();
    await db.$client.end();
  });

  it("persists code-file pushes as raw code text", async () => {
    const userId = randomUUID();
    const projectId = randomUUID();
    const workId = randomUUID();
    const sourceId = randomUUID();
    const documentId = randomUUID();
    const threadId = randomUUID();
    const turnId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "branch-push-projection"));
    await db.insert(projects).values({
      id: projectId,
      userId,
      name: "Projection project",
      slug: `projection-${projectId}`,
    });
    await db.insert(works).values({
      id: workId,
      projectId,
      createdByUserId: userId,
      title: "Projection work",
    });
    await db.insert(contextSources).values({
      id: sourceId,
      projectId,
      name: "Manuscript",
      slug: "manuscript",
      scope: "project",
      isPrimary: true,
    });
    await db.insert(documents).values({
      id: documentId,
      contextSourceId: sourceId,
      name: "example",
      extension: "ts",
      fileType: "typescript",
    });
    await db.insert(threads).values({
      id: threadId,
      projectId,
      createdByUserId: userId,
      title: "Projection thread",
      kind: "primary",
      status: "active",
    });
    await db.insert(turns).values({
      id: turnId,
      threadId,
      role: "assistant",
      status: "complete",
    });
    await db.insert(threadWorks).values({ threadId, workId, projectId, isPrimary: true });
    await persistence.lifecycle.ensureDocument(documentId as never);

    const schema = buildDocumentSchema();
    const model = yProsemirrorModel(schema);
    const codec = mdxCodec({ schema });
    const durableProjectionSerializer = createMarkdownDocumentEngine({
      schema,
      model,
      codec,
      journal: persistence.journal,
      coordinator: liveCoordinator,
      lifecycle: persistence.lifecycle,
      initialDocumentSeeds: persistence.lifecycle,
      metaForOrigin: () => ({ origin: "system", seq: 0 }),
      resolveFiletype: async (resolvedDocumentId) => {
        const [row] = await db
          .select({ filetype: documents.fileType })
          .from(documents)
          .where(eq(documents.id, resolvedDocumentId));
        return row?.filetype ?? null;
      },
    });
    const branchCoordinator = createBranchCoordinator({ store: branchStore });
    const liveDoc = createCollabYDoc({ gc: false });
    const branch = await branchStore.ensureWorkDraftBranch({
      documentId: documentId as never,
      workId: workId as never,
      liveDoc,
    });
    const code = "const answer = 42;\nconsole.log(answer);";
    const branchDoc = createCollabYDoc({ gc: false });
    model.insertBlocks(toDocHandle(branchDoc), null, {
      blocks: [schema.nodes.code_block.create({ language: "typescript" }, schema.text(code))],
    });
    await branchCoordinator.commitUpdate({
      branchId: branch.branchId,
      updateData: Y.encodeStateAsUpdate(branchDoc),
      source: "agent",
      threadId: threadId as never,
      turnId: turnId as never,
    });
    const changeTrails = createDrizzleChangeTrailPersistence(db);
    const journalReadStore = createDrizzleBranchJournalReadStore(db);
    const commitStore = createDrizzlePushCommitStore(
      db,
      stagePendingSettlementWithinTx,
      changeTrails,
    );
    const workPushPolicyStore = createDrizzleWorkPushPolicyStore(db);
    const branchPush = createBranchPushService({
      branchStore,
      journalReadStore,
      commitStore,
      workPushPolicyStore,
      settlementStore: createDrizzlePendingSettlementStore(
        db,
        durableProjectionSerializer,
        changeTrails,
      ),
      branchCoordinator,
      journal: persistence.journal,
      liveCoordinator,
      model,
      codec,
    });

    await expect(branchPush.pushToLive({ branchId: branch.branchId })).resolves.toMatchObject({
      status: "pushed",
    });
    const [persisted] = await db
      .select({ markdownProjection: documents.markdownProjection })
      .from(documents)
      .where(eq(documents.id, documentId));
    expect(persisted?.markdownProjection).toBe(code);

    await db
      .update(documents)
      .set({ extension: "png", fileType: "png" })
      .where(eq(documents.id, documentId));
    const currentLive = createCollabYDoc({ gc: false });
    await liveCoordinator.withDocument(documentId, (doc) => {
      Y.applyUpdate(currentLive, Y.encodeStateAsUpdate(doc));
    });
    const nextBranch = await branchStore.ensureWorkDraftBranch({
      documentId: documentId as never,
      workId: workId as never,
      liveDoc: currentLive,
    });
    const nextBranchDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(nextBranchDoc, Y.encodeStateAsUpdate(currentLive));
    const [codeBlock] = model.getBlocks(toDocHandle(nextBranchDoc));
    if (!codeBlock) throw new Error("Code block is unavailable after the first push");
    model.applyTextEdit(
      toDocHandle(nextBranchDoc),
      codeBlock,
      { from: code.length, to: code.length },
      "\n// unsupported projection",
    );
    await branchCoordinator.commitSyncFromDoc({
      branchId: nextBranch.branchId,
      expectedGeneration: nextBranch.generation,
      sourceDoc: nextBranchDoc,
      source: "agent",
      threadId: threadId as never,
      turnId: turnId as never,
    });

    await expect(branchPush.pushToLive({ branchId: nextBranch.branchId })).rejects.toThrow(
      "Tracked document has registered binary filetype: png",
    );
    const [blocked] = await db
      .select({
        state: branchPushSettlementOutbox.state,
        lastErrorCode: branchPushSettlementOutbox.lastErrorCode,
      })
      .from(branchPushSettlementOutbox)
      .where(eq(branchPushSettlementOutbox.documentId, documentId))
      .orderBy(desc(branchPushSettlementOutbox.pushId))
      .limit(1);
    expect(blocked).toEqual({ state: "blocked", lastErrorCode: "corrupt_state" });
    const [afterBlocked] = await db
      .select({ markdownProjection: documents.markdownProjection })
      .from(documents)
      .where(eq(documents.id, documentId));
    expect(afterBlocked?.markdownProjection).toBe(code);

    nextBranchDoc.destroy();
    currentLive.destroy();
    branchDoc.destroy();
    liveDoc.destroy();
  });

  it("keeps a generic projection failure pending and completes it on recovery", async () => {
    const userId = randomUUID();
    const projectId = randomUUID();
    const workId = randomUUID();
    const sourceId = randomUUID();
    const documentId = randomUUID();
    const threadId = randomUUID();
    const turnId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "branch-push-recovery"));
    await db.insert(projects).values({
      id: projectId,
      userId,
      name: "Recovery project",
      slug: `recovery-${projectId}`,
    });
    await db.insert(works).values({
      id: workId,
      projectId,
      createdByUserId: userId,
      title: "Recovery work",
    });
    await db.insert(contextSources).values({
      id: sourceId,
      projectId,
      name: "Manuscript",
      slug: "manuscript",
      scope: "project",
      isPrimary: true,
    });
    await db.insert(documents).values({
      id: documentId,
      contextSourceId: sourceId,
      name: "chapter",
      extension: "md",
      fileType: "markdown",
    });
    await db.insert(threads).values({
      id: threadId,
      projectId,
      createdByUserId: userId,
      title: "Recovery thread",
      kind: "primary",
      status: "active",
    });
    await db.insert(turns).values({
      id: turnId,
      threadId,
      role: "assistant",
      status: "complete",
    });
    await db.insert(threadWorks).values({ threadId, workId, projectId, isPrimary: true });
    await persistence.lifecycle.ensureDocument(documentId as never);

    const schema = buildDocumentSchema();
    const model = yProsemirrorModel(schema);
    const codec = mdxCodec({ schema });
    const engine = createMarkdownDocumentEngine({
      schema,
      model,
      codec,
      journal: persistence.journal,
      coordinator: liveCoordinator,
      lifecycle: persistence.lifecycle,
      initialDocumentSeeds: persistence.lifecycle,
      metaForOrigin: () => ({ origin: "system", seq: 0 }),
      resolveFiletype: async () => "markdown",
    });
    let failProjection = true;
    const serializer = {
      async serializeDocument(resolvedDocumentId: string, doc: Y.Doc) {
        if (failProjection) throw new Error("injected generic projection failure");
        return engine.serializeDocument(resolvedDocumentId as never, doc);
      },
    };
    const changeTrails = createDrizzleChangeTrailPersistence(db);
    const journalReadStore = createDrizzleBranchJournalReadStore(db);
    const commitStore = createDrizzlePushCommitStore(
      db,
      stagePendingSettlementWithinTx,
      changeTrails,
    );
    const workPushPolicyStore = createDrizzleWorkPushPolicyStore(db);
    const settlementStore = createDrizzlePendingSettlementStore(db, serializer, changeTrails);
    const branchCoordinator = createBranchCoordinator({ store: branchStore });
    const liveDoc = createCollabYDoc({ gc: false });
    const branch = await branchStore.ensureWorkDraftBranch({
      documentId: documentId as never,
      workId: workId as never,
      liveDoc,
    });
    const branchDoc = createCollabYDoc({ gc: false });
    model.insertBlocks(toDocHandle(branchDoc), null, codec.parse("Recovered projection"));
    await branchCoordinator.commitUpdate({
      branchId: branch.branchId,
      updateData: Y.encodeStateAsUpdate(branchDoc),
      source: "agent",
      threadId: threadId as never,
      turnId: turnId as never,
    });
    const branchPush = createBranchPushService({
      branchStore,
      journalReadStore,
      commitStore,
      workPushPolicyStore,
      settlementStore,
      branchCoordinator,
      journal: persistence.journal,
      liveCoordinator,
      model,
      codec,
    });

    await expect(branchPush.pushToLive({ branchId: branch.branchId })).rejects.toThrow(
      "injected generic projection failure",
    );
    const journalAfterFailure = await db
      .select({ id: documentYjsUpdates.id })
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, documentId));
    expect(journalAfterFailure).toEqual([]);
    const [documentAfterFailure] = await db
      .select({ markdownProjection: documents.markdownProjection })
      .from(documents)
      .where(eq(documents.id, documentId));
    expect(documentAfterFailure?.markdownProjection).toBe("");
    const [pending] = await db
      .select({
        pushId: branchPushSettlementOutbox.pushId,
        state: branchPushSettlementOutbox.state,
        lastErrorCode: branchPushSettlementOutbox.lastErrorCode,
      })
      .from(branchPushSettlementOutbox)
      .where(eq(branchPushSettlementOutbox.documentId, documentId))
      .limit(1);
    expect(pending).toMatchObject({ state: "pending", lastErrorCode: null });
    if (!pending) throw new Error("missing pending settlement");
    const liveSettlement = await settlementStore.loadLiveSettlement(pending.pushId);
    if (!liveSettlement) throw new Error("missing live settlement");
    await expect(
      settlementStore.handoffClaim({
        pushId: pending.pushId,
        claim: liveSettlement.claim,
      }),
    ).resolves.toBe(true);

    failProjection = false;
    await expect(branchPush.recoverPendingLiveSettlements()).resolves.toBe(1);
    const [completed] = await db
      .select({ state: branchPushSettlementOutbox.state })
      .from(branchPushSettlementOutbox)
      .where(eq(branchPushSettlementOutbox.pushId, pending.pushId));
    expect(completed?.state).toBe("completed");
    const journalAfterRecovery = await db
      .select({ id: documentYjsUpdates.id })
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, documentId));
    expect(journalAfterRecovery).toHaveLength(1);
    const [documentAfterRecovery] = await db
      .select({ markdownProjection: documents.markdownProjection })
      .from(documents)
      .where(eq(documents.id, documentId));
    expect(documentAfterRecovery?.markdownProjection).toBe("Recovered projection\n");

    branchDoc.destroy();
    liveDoc.destroy();
  });
});
