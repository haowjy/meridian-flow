/** PostgreSQL regression coverage for filetype-aware branch-push projections. */

import { randomUUID } from "node:crypto";
import {
  createAgentEditCodecFactory,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  branchPushSettlementBatches,
  branchPushSettlementOutbox,
  contextSources,
  documentDerivations,
  documentMarkdownProjections,
  documents,
  documentYjsUpdates,
  projects,
  threadDocuments,
  threads,
  threadWorks,
  turns,
  users,
  works,
} from "@meridian/database/schema";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDocumentLastAddress } from "../context/document-uri-resolver.js";
import {
  createDrizzleBranchJournalReadStore,
  createDrizzlePushCommitStore,
} from "./adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "./adapters/drizzle-branches.js";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
import { createDrizzleDocumentProjectionEffects } from "./adapters/drizzle-document-activity.js";
import { createDrizzleDocumentDerivationStore } from "./adapters/drizzle-document-derivations.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "./adapters/drizzle-drafts.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import {
  createDrizzlePendingSettlementStore,
  stageSettlementBatchWithinTx,
} from "./adapters/drizzle-pending-settlement.js";
import { createStaticDocumentLinkScopes } from "./adapters/in-memory/static-document-link-scopes.js";
import { createBranchCoordinator } from "./domain/branch-coordinator.js";
import { createBranchPushService } from "./domain/branch-push.js";
import { createDrafts } from "./domain/drafts.js";
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
  const drafts = createDrafts({
    store: createDrizzleDraftStore(db),
    boundary: createDrizzleDraftWriteBoundary(db),
  });
  const branchStore = createDrizzleBranchStore(db, {
    live: {
      journal: persistence.journal,
      lifecycle: persistence.lifecycle,
    },
    drafts,
  });

  afterAll(async () => {
    for (const doc of liveDocs.values()) doc.destroy();
    await db.$client.end();
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
      name: "Recovery work",
      slug: "recovery-work",
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
      extension: "",
      fileType: "markdown",
    });
    await db.insert(threads).values({
      rootThreadId: threadId,
      id: threadId,
      projectId,
      createdByUserId: userId,
      title: "Recovery thread",
      kind: "primary",
      status: "idle",
    });
    await db.insert(turns).values({
      id: turnId,
      threadId,
      position: 1,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await db.insert(threadWorks).values({ threadId, workId, projectId, isPrimary: true });
    await persistence.lifecycle.ensureDocument(documentId as never);

    const schema = buildDocumentSchema();
    const model = yProsemirrorModel(schema);
    const codec = mdxCodec({ schema });
    const engine = createMarkdownDocumentEngine({
      links: createStaticDocumentLinkScopes(),
      model,
      codec,
      journal: persistence.journal,
      coordinator: liveCoordinator,
      lifecycle: persistence.lifecycle,
      initialDocumentSeeds: persistence.lifecycle,
      metaForOrigin: () => ({ origin: "system", seq: 0 }),
      identityPreservingWrite: async () => {
        throw new Error("Identity-preserving writes are not part of this projection scenario");
      },
      resolveFiletype: async () => "markdown",
    });
    let failProjection = true;
    const serializer = {
      async serializeDocument(resolvedDocumentId: string, doc: Y.Doc) {
        if (failProjection) throw new Error("injected generic projection failure");
        return engine.serializeDocument(resolvedDocumentId as never, doc, { kind: "live" });
      },
    };
    const changeTrails = createDrizzleChangeTrailAggregateWriter(db);
    const journalReadStore = createDrizzleBranchJournalReadStore(db);
    const commitStore = createDrizzlePushCommitStore(
      db,
      stageSettlementBatchWithinTx,
      changeTrails,
    );
    const settlementStore = createDrizzlePendingSettlementStore(
      db,
      serializer,
      createDrizzleDocumentProjectionEffects(db),
      changeTrails,
      createDrizzleDocumentDerivationStore(db, createDocumentLastAddress(db)),
    );
    const branchCoordinator = createBranchCoordinator({ store: branchStore });
    const liveDoc = createCollabYDoc({ gc: false });
    const draft = await drafts.ensureActiveForWrite({
      workId: workId as never,
      projectId: projectId as never,
      threadId: null,
      userId: userId as never,
    });
    const branch = await branchStore.ensureDraftBranch({
      documentId: documentId as never,
      draftId: draft.id,
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
      links: createStaticDocumentLinkScopes(),
      changeEventDelivery: { deliver() {} },
      branchStore,
      journalReadStore,
      commitStore,
      settlementStore,
      branchCoordinator,
      journal: persistence.journal,
      liveCoordinator,
      model,
      codec: createAgentEditCodecFactory(codec),
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
      .select({ markdownProjection: documentMarkdownProjections.markdown })
      .from(documentMarkdownProjections)
      .where(eq(documentMarkdownProjections.documentId, documentId));
    expect(documentAfterFailure).toBeUndefined();
    const [pending] = await db
      .select({
        batchId: branchPushSettlementBatches.id,
        state: branchPushSettlementBatches.state,
        lastErrorCode: branchPushSettlementBatches.lastErrorCode,
      })
      .from(branchPushSettlementOutbox)
      .innerJoin(
        branchPushSettlementBatches,
        eq(branchPushSettlementBatches.id, branchPushSettlementOutbox.batchId),
      )
      .where(eq(branchPushSettlementOutbox.documentId, documentId))
      .limit(1);
    expect(pending).toMatchObject({ state: "pending", lastErrorCode: null });
    if (!pending) throw new Error("missing pending settlement");
    // The warm owner hands the batch off, as a process that gave up would.
    await db
      .update(branchPushSettlementBatches)
      .set({ claimToken: null, claimKind: null, claimedAt: null, leaseExpiresAt: null })
      .where(eq(branchPushSettlementBatches.id, pending.batchId));

    failProjection = false;
    await expect(branchPush.recoverPendingLiveSettlements()).resolves.toBe(1);
    const [completed] = await db
      .select({ state: branchPushSettlementBatches.state })
      .from(branchPushSettlementBatches)
      .where(eq(branchPushSettlementBatches.id, pending.batchId));
    expect(completed?.state).toBe("completed");
    const journalAfterRecovery = await db
      .select({
        id: documentYjsUpdates.id,
        originType: documentYjsUpdates.originType,
        actorTurnId: documentYjsUpdates.actorTurnId,
      })
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, documentId))
      .orderBy(documentYjsUpdates.id);
    expect(journalAfterRecovery).toEqual([
      expect.objectContaining({ originType: "agent", actorTurnId: turnId }),
      expect.objectContaining({ originType: "reconcile", actorTurnId: null }),
    ]);
    const [documentAfterRecovery] = await db
      .select({ markdownProjection: documentMarkdownProjections.markdown })
      .from(documentMarkdownProjections)
      .where(eq(documentMarkdownProjections.documentId, documentId));
    expect(documentAfterRecovery?.markdownProjection).toBe("Recovered projection\n");
    const [watermark] = await db
      .select()
      .from(documentDerivations)
      .where(eq(documentDerivations.documentId, documentId));
    expect(watermark?.projectionAdmissionSequence).toBe(2n);

    branchDoc.destroy();
    liveDoc.destroy();
  });

  it("rolls back projection and activity when push completion retries", async () => {
    const userId = randomUUID();
    const projectId = randomUUID();
    const workId = randomUUID();
    const sourceId = randomUUID();
    const documentId = randomUUID();
    const threadId = randomUUID();
    const turnId = randomUUID();
    const old = new Date("2026-01-01T00:00:00.000Z");
    await db.insert(users).values(conformanceUserValues(userId, "branch-push-retry-rollback"));
    await db.insert(projects).values({
      id: projectId,
      userId,
      name: "Retry rollback project",
      slug: `retry-rollback-${projectId}`,
      updatedAt: old,
      lastActivityAt: old,
    });
    await db.insert(works).values({
      id: workId,
      projectId,
      createdByUserId: userId,
      name: "Retry rollback work",
      slug: "retry-rollback-work",
      updatedAt: old,
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
      extension: "",
      fileType: "markdown",
      updatedAt: old,
    });
    await db
      .insert(documentMarkdownProjections)
      .values({ documentId, markdown: "stale projection" });
    await db.insert(threads).values({
      rootThreadId: threadId,
      id: threadId,
      projectId,
      createdByUserId: userId,
      title: "Retry rollback thread",
      kind: "primary",
      status: "idle",
    });
    await db.insert(threadDocuments).values({
      threadId,
      documentId,
      relationship: "editing",
      firstTouchedAt: old,
      lastTouchedAt: old,
    });
    await db.insert(turns).values({
      id: turnId,
      threadId,
      position: 1,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await db.insert(threadWorks).values({ threadId, workId, projectId, isPrimary: true });
    await persistence.lifecycle.ensureDocument(documentId as never);

    const schema = buildDocumentSchema();
    const model = yProsemirrorModel(schema);
    const codec = mdxCodec({ schema });
    const engine = createMarkdownDocumentEngine({
      links: createStaticDocumentLinkScopes(),
      model,
      codec,
      journal: persistence.journal,
      coordinator: liveCoordinator,
      lifecycle: persistence.lifecycle,
      initialDocumentSeeds: persistence.lifecycle,
      metaForOrigin: () => ({ origin: "system", seq: 0 }),
      identityPreservingWrite: async () => {
        throw new Error("Identity-preserving writes are not part of this projection scenario");
      },
      resolveFiletype: async () => "markdown",
    });
    const changeTrails = createDrizzleChangeTrailAggregateWriter(db);
    const journalReadStore = createDrizzleBranchJournalReadStore(db);
    const commitStore = createDrizzlePushCommitStore(
      db,
      stageSettlementBatchWithinTx,
      changeTrails,
    );
    const branchCoordinator = createBranchCoordinator({ store: branchStore });
    const liveDoc = createCollabYDoc({ gc: false });
    const draft = await drafts.ensureActiveForWrite({
      workId: workId as never,
      projectId: projectId as never,
      threadId: null,
      userId: userId as never,
    });
    const branch = await branchStore.ensureDraftBranch({
      documentId: documentId as never,
      draftId: draft.id,
      liveDoc,
    });
    const branchDoc = createCollabYDoc({ gc: false });
    model.insertBlocks(toDocHandle(branchDoc), null, codec.parse("Never completed"));
    await branchCoordinator.commitUpdate({
      branchId: branch.branchId,
      updateData: Y.encodeStateAsUpdate(branchDoc),
      source: "agent",
      threadId: threadId as never,
      turnId: turnId as never,
    });
    const branchPush = createBranchPushService({
      links: createStaticDocumentLinkScopes(),
      changeEventDelivery: { deliver() {} },
      branchStore,
      journalReadStore,
      commitStore,
      settlementStore: createDrizzlePendingSettlementStore(
        db,
        engine,
        createDrizzleDocumentProjectionEffects(db),
        changeTrails,
        createDrizzleDocumentDerivationStore(db, createDocumentLastAddress(db)),
      ),
      branchCoordinator,
      journal: persistence.journal,
      liveCoordinator,
      model,
      codec: createAgentEditCodecFactory(codec),
      writerIngressBarrier: {
        drain: async () => 1,
        isGenerationCurrent: () => false,
      },
    });

    await expect(branchPush.pushToLive({ branchId: branch.branchId })).rejects.toThrow(
      /remains pending after bounded retries/,
    );

    const [document] = await db
      .select({
        markdownProjection: documentMarkdownProjections.markdown,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .leftJoin(
        documentMarkdownProjections,
        eq(documentMarkdownProjections.documentId, documents.id),
      )
      .where(eq(documents.id, documentId));
    const [threadDocument] = await db
      .select({ lastTouchedAt: threadDocuments.lastTouchedAt })
      .from(threadDocuments)
      .where(eq(threadDocuments.documentId, documentId));
    const [work] = await db
      .select({ updatedAt: works.updatedAt })
      .from(works)
      .where(eq(works.id, workId));
    const [project] = await db
      .select({ updatedAt: projects.updatedAt, lastActivityAt: projects.lastActivityAt })
      .from(projects)
      .where(eq(projects.id, projectId));
    const journal = await db
      .select({ id: documentYjsUpdates.id })
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, documentId));

    expect(document?.markdownProjection).toBe("stale projection");
    expect(document?.updatedAt.toISOString()).toBe(old.toISOString());
    expect(threadDocument?.lastTouchedAt.toISOString()).toBe(old.toISOString());
    expect(work?.updatedAt.toISOString()).toBe(old.toISOString());
    expect(project?.updatedAt.toISOString()).toBe(old.toISOString());
    expect(project?.lastActivityAt.toISOString()).toBe(old.toISOString());
    expect(journal).toEqual([]);

    branchDoc.destroy();
    liveDoc.destroy();
  });
});
