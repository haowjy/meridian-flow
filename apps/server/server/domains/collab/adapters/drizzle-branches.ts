/** Drizzle persistence adapter for shadow branch peers and manifest peers. */
import { randomUUID } from "node:crypto";
import type { DocumentCoordinator, DocumentLifecycle, UpdateJournal } from "@meridian/agent-edit";
import type { DocumentId, ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branchWriteJournal,
  contextSources,
  documentBranches,
  documents,
  documentYjsHeads,
  manuscriptDocumentPredicate,
  threadWorks,
} from "@meridian/database/schema";
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import {
  type AppendBranchJournalInput,
  assertReadableBranch,
  type BranchSnapshot,
  type BranchStore,
  type CommitBranchMutationInput,
  type PersistBranchInput,
  type ResetBranchSnapshotInput,
} from "../domain/branch-coordinator.js";
import {
  BranchCorruptError,
  BranchNotFoundError,
  type BranchResolver,
  type BranchState,
} from "../domain/branch-resolver.js";

export type DrizzleBranchStore = BranchStore &
  BranchResolver & {
    listActiveWorkDraftBranchIds(documentId: DocumentId): Promise<string[]>;
    ensureWorkDraftBranch(input: {
      documentId: DocumentId;
      workId: WorkId;
      liveDoc: Y.Doc;
    }): Promise<BranchSnapshot>;
    ensureThreadPeerBranch(input: {
      documentId: DocumentId;
      threadId: ThreadId;
      liveDoc: Y.Doc;
    }): Promise<BranchSnapshot>;
    ensureProjectManifest(input: { projectId: ProjectId; contextSourceId?: string }): Promise<{
      documentId: DocumentId;
      doc: Y.Doc;
    }>;
    syncManifestToDocuments(
      projectId: ProjectId,
    ): Promise<{ documentId: DocumentId; members: string[] }>;
    resolveManifestMembership(input: {
      projectId: ProjectId;
      workId?: WorkId | null;
      threadId?: ThreadId | null;
    }): Promise<{ documentId: DocumentId; members: string[] }>;
    recordManifestDocumentCreated(documentId: DocumentId): Promise<void>;
    recordManifestDocumentDeleted(documentId: DocumentId): Promise<void>;
  };

export function createDrizzleBranchStore(
  db: Database,
  live?: {
    journal: UpdateJournal;
    lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
    coordinator: DocumentCoordinator;
  },
): DrizzleBranchStore {
  async function findPrimaryWork(threadId: ThreadId): Promise<WorkId> {
    const [row] = await currentDrizzleDb(db)
      .select({ workId: threadWorks.workId })
      .from(threadWorks)
      .where(and(eq(threadWorks.threadId, threadId), eq(threadWorks.isPrimary, true)))
      .limit(1);
    if (!row) throw new Error(`Thread ${threadId} is not linked to a primary work`);
    return row.workId;
  }

  async function activeWorkDraft(
    documentId: DocumentId,
    workId: WorkId,
  ): Promise<BranchSnapshot | null> {
    const [row] = await selectBranch(currentDrizzleDb(db))
      .where(
        and(
          eq(documentBranches.documentId, documentId),
          eq(documentBranches.workId, workId),
          eq(documentBranches.kind, "work_draft"),
          eq(documentBranches.status, "active"),
        ),
      )
      .limit(1);
    return row ? mapBranch(row) : null;
  }

  async function insertBranch(
    values: typeof documentBranches.$inferInsert,
  ): Promise<BranchSnapshot> {
    const [row] = await currentDrizzleDb(db).insert(documentBranches).values(values).returning();
    if (!row) throw new Error("Failed to create document branch");
    return mapBranch({
      branchId: row.id,
      documentId: row.documentId,
      kind: row.kind,
      upstreamBranchId: row.upstreamBranchId,
      workId: row.workId,
      threadId: row.threadId,
      pushPolicy: row.pushPolicy,
      status: row.status,
      generation: row.generation,
      state: row.state,
      stateVector: row.stateVector,
      schemaVersion: row.schemaVersion,
    });
  }

  function snapshotFromDoc(doc: Y.Doc): { state: Buffer; stateVector: Buffer } {
    return {
      state: Buffer.from(Y.encodeStateAsUpdate(doc)),
      stateVector: Buffer.from(Y.encodeStateVector(doc)),
    };
  }

  async function liveSchemaVersion(documentId: DocumentId): Promise<number> {
    const [row] = await currentDrizzleDb(db)
      .select({ schemaVersion: documentYjsHeads.schemaVersion })
      .from(documentYjsHeads)
      .where(eq(documentYjsHeads.documentId, documentId))
      .limit(1);
    return row?.schemaVersion ?? COLLAB_SCHEMA_VERSION;
  }

  async function persistLiveManifestUpdate(
    documentId: DocumentId,
    update: Uint8Array,
  ): Promise<void> {
    if (!live) {
      throw new Error("DrizzleBranchStore manifest persistence requires the collab live journal");
    }
    await live.journal.append(documentId, update, { origin: "system", seq: 0 });
    await live.coordinator.withDocument(documentId, async (doc) => {
      Y.applyUpdate(doc, update);
    });
  }

  async function ensureLiveManifestDocument(documentId: DocumentId): Promise<Y.Doc> {
    if (!live) {
      throw new Error("DrizzleBranchStore manifest reads require the collab live lifecycle");
    }
    await live.lifecycle.ensureDocument(documentId);
    const snapshot = await live.journal.read(documentId);
    const doc = createCollabYDoc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const update of snapshot.updates) Y.applyUpdate(doc, update.update);
    return doc;
  }

  async function seedLiveManifestIfEmpty(
    documentId: DocumentId,
    projectId: ProjectId,
  ): Promise<Y.Doc> {
    const doc = await ensureLiveManifestDocument(documentId);
    const map = doc.getMap<{ present: true }>("documents");
    const before = Y.encodeStateVector(doc);
    for (const row of await listProjectManuscriptDocumentIds(projectId)) {
      map.set(row, { present: true });
    }
    const update = Y.encodeStateAsUpdate(doc, before);
    if (hasYjsUpdate(update)) await persistLiveManifestUpdate(documentId, update);
    return doc;
  }

  async function ensureWorkDraftBranch(input: {
    documentId: DocumentId;
    workId: WorkId;
    liveDoc: Y.Doc;
  }): Promise<BranchSnapshot> {
    const existing = await activeWorkDraft(input.documentId, input.workId);
    if (existing) return existing;
    const seed = snapshotFromDoc(input.liveDoc);
    return insertBranch({
      id: `branch_${randomUUID()}`,
      documentId: input.documentId,
      kind: "work_draft",
      upstreamBranchId: null,
      workId: input.workId,
      threadId: null,
      pushPolicy: "manual",
      status: "active",
      ...seed,
      schemaVersion: await liveSchemaVersion(input.documentId),
    });
  }

  async function ensureThreadPeerBranch(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    liveDoc: Y.Doc;
  }): Promise<BranchSnapshot> {
    const existing = await findActiveThreadPeer(input.documentId, input.threadId);
    if (existing) return existing;
    const workId = await findPrimaryWork(input.threadId);
    const workDraft = await ensureWorkDraftBranch({
      documentId: input.documentId,
      workId,
      liveDoc: input.liveDoc,
    });
    const upstreamDoc = materializeBranch(workDraft, input.threadId);
    try {
      return await insertBranch({
        id: `branch_${randomUUID()}`,
        documentId: input.documentId,
        kind: "thread_peer",
        upstreamBranchId: workDraft.branchId,
        workId,
        threadId: input.threadId,
        pushPolicy: workDraft.pushPolicy,
        status: "active",
        ...snapshotFromDoc(upstreamDoc),
        schemaVersion: workDraft.schemaVersion,
      });
    } finally {
      upstreamDoc.destroy();
    }
  }

  async function findActiveThreadPeer(
    documentId: DocumentId,
    threadId: ThreadId,
  ): Promise<BranchSnapshot | null> {
    const [row] = await selectBranch(currentDrizzleDb(db))
      .where(
        and(
          eq(documentBranches.documentId, documentId),
          eq(documentBranches.threadId, threadId),
          eq(documentBranches.kind, "thread_peer"),
          eq(documentBranches.status, "active"),
        ),
      )
      .limit(1);
    return row ? mapBranch(row) : null;
  }

  async function projectForDocument(documentId: DocumentId): Promise<ProjectId | null> {
    const [row] = await currentDrizzleDb(db)
      .select({ projectId: contextSources.projectId })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .where(eq(documents.id, documentId))
      .limit(1);
    return (row?.projectId as ProjectId | null | undefined) ?? null;
  }

  async function ensureProjectManifest(input: {
    projectId: ProjectId;
    contextSourceId?: string;
  }): Promise<{ documentId: DocumentId; doc: Y.Doc }> {
    const txDb = currentDrizzleDb(db);
    const [existing] = await txDb
      .select({ id: documents.id })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .where(
        and(
          eq(contextSources.projectId, input.projectId),
          eq(documents.kind, "manifest"),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1);
    if (existing?.id) {
      return {
        documentId: existing.id as DocumentId,
        doc: await ensureLiveManifestDocument(existing.id as DocumentId),
      };
    }
    const documentId = await createManifestIdentity(input.projectId, input.contextSourceId);
    return {
      documentId,
      doc: await seedLiveManifestIfEmpty(documentId, input.projectId),
    };
  }

  async function createManifestIdentity(
    projectId: ProjectId,
    explicitContextSourceId?: string,
  ): Promise<DocumentId> {
    const txDb = currentDrizzleDb(db);
    const contextSourceId = explicitContextSourceId ?? (await findProjectContextSource(projectId));
    const [row] = await txDb
      .insert(documents)
      .values({
        id: randomUUID() as DocumentId,
        contextSourceId,
        kind: "manifest",
        name: ".manifest",
        extension: "json",
        fileType: "json",
        markdownProjection: "",
      })
      .returning({ id: documents.id });
    if (!row) throw new Error("Failed to create project manifest identity document");
    return row.id;
  }

  async function findProjectContextSource(projectId: ProjectId): Promise<string> {
    const [row] = await currentDrizzleDb(db)
      .select({ id: contextSources.id })
      .from(contextSources)
      .where(and(eq(contextSources.projectId, projectId), isNull(contextSources.deletedAt)))
      .orderBy(sql`${contextSources.isPrimary} DESC`, contextSources.createdAt)
      .limit(1);
    if (!row) throw new Error(`Project ${projectId} has no context source for a manifest identity`);
    return row.id;
  }

  async function listProjectManuscriptDocumentIds(projectId: ProjectId): Promise<DocumentId[]> {
    const rows = await currentDrizzleDb(db)
      .select({ id: documents.id })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .where(
        and(
          eq(contextSources.projectId, projectId),
          manuscriptDocumentPredicate(),
          isNull(documents.deletedAt),
        ),
      );
    return rows.map((row) => row.id as DocumentId);
  }

  async function syncManifestToDocuments(
    projectId: ProjectId,
  ): Promise<{ documentId: DocumentId; members: string[] }> {
    return resolveManifestMembership({ projectId });
  }

  async function resolveManifestMembership(input: {
    projectId: ProjectId;
    workId?: WorkId | null;
    threadId?: ThreadId | null;
  }): Promise<{ documentId: DocumentId; members: string[] }> {
    const manifest = await ensureProjectManifest({ projectId: input.projectId });
    let doc = manifest.doc;
    if (input.threadId) {
      const peer = await ensureThreadPeerBranch({
        documentId: manifest.documentId,
        threadId: input.threadId,
        liveDoc: manifest.doc,
      });
      doc = materializeBranch(peer, input.threadId);
    } else if (input.workId) {
      const work = await ensureWorkDraftBranch({
        documentId: manifest.documentId,
        workId: input.workId,
        liveDoc: manifest.doc,
      });
      doc = materializeBranch(work, "" as ThreadId);
    }
    try {
      const present = [...doc.getMap<{ present: true }>("documents").keys()].sort();
      return { documentId: manifest.documentId, members: present };
    } finally {
      if (doc !== manifest.doc) doc.destroy();
      manifest.doc.destroy();
    }
  }

  async function updateBranchSnapshot(
    input: PersistBranchInput | ResetBranchSnapshotInput,
  ): Promise<boolean> {
    const [row] = await currentDrizzleDb(db)
      .update(documentBranches)
      .set({
        state: Buffer.from(input.state),
        stateVector: Buffer.from(input.stateVector),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentBranches.id, input.branchId),
          eq(documentBranches.status, "active"),
          eq(documentBranches.generation, input.expectedGeneration),
          eq(documentBranches.stateVector, Buffer.from(input.expectedStateVector)),
        ),
      )
      .returning({ id: documentBranches.id });
    return Boolean(row);
  }

  async function mutateLiveManifest(documentId: DocumentId, present: boolean): Promise<void> {
    const projectId = await projectForDocument(documentId);
    if (!projectId) return;
    const manifest = await ensureProjectManifest({ projectId });
    const map = manifest.doc.getMap<{ present: true }>("documents");
    const before = Y.encodeStateVector(manifest.doc);
    if (present) {
      if (map.has(documentId)) return;
      map.set(documentId, { present: true });
    } else {
      if (!map.has(documentId)) return;
      map.delete(documentId);
    }
    const update = Y.encodeStateAsUpdate(manifest.doc, before);
    if (hasYjsUpdate(update)) await persistLiveManifestUpdate(manifest.documentId, update);
  }

  return {
    async getBranch(branchId) {
      const [row] = await selectBranch(currentDrizzleDb(db))
        .where(eq(documentBranches.id, branchId))
        .limit(1);
      return row ? mapBranch(row) : null;
    },

    async updateBranchSnapshot(input: PersistBranchInput) {
      return updateBranchSnapshot(input);
    },

    async commitBranchMutation(input: CommitBranchMutationInput) {
      return runInDrizzleTransaction(db, async () => {
        if (input.journal && input.journal.generation !== input.expectedGeneration) {
          throw new BranchMutationRollback();
        }
        const ok = await updateBranchSnapshot(input);
        if (!ok) throw new BranchMutationRollback();
        if (input.journal) {
          await currentDrizzleDb(db)
            .insert(branchWriteJournal)
            .values({
              branchId: input.journal.branchId,
              generation: input.journal.generation,
              updateData: Buffer.from(input.journal.updateData),
              source: input.journal.source,
              wId: input.journal.wId ?? null,
              threadId: input.journal.threadId ?? null,
              turnId: input.journal.turnId ?? null,
              actorUserId: input.journal.actorUserId ?? null,
              updateMeta: input.journal.updateMeta ?? null,
            });
        }
        return true;
      }).catch((cause) => {
        if (cause instanceof BranchMutationRollback) return false;
        throw cause;
      });
    },

    async resetBranchSnapshot(input: ResetBranchSnapshotInput) {
      const [row] = await currentDrizzleDb(db)
        .update(documentBranches)
        .set({
          generation: sql`${documentBranches.generation} + 1`,
          state: Buffer.from(input.state),
          stateVector: Buffer.from(input.stateVector),
          schemaVersion: input.schemaVersion,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documentBranches.id, input.branchId),
            eq(documentBranches.status, "active"),
            eq(documentBranches.generation, input.expectedGeneration),
            eq(documentBranches.stateVector, Buffer.from(input.expectedStateVector)),
          ),
        )
        .returning({ id: documentBranches.id });
      return Boolean(row);
    },

    async appendJournal(input: AppendBranchJournalInput) {
      await currentDrizzleDb(db)
        .insert(branchWriteJournal)
        .values({
          branchId: input.branchId,
          generation: input.generation,
          updateData: Buffer.from(input.updateData),
          source: input.source,
          wId: input.wId ?? null,
          threadId: input.threadId ?? null,
          turnId: input.turnId ?? null,
          actorUserId: input.actorUserId ?? null,
          updateMeta: input.updateMeta ?? null,
        });
    },

    async resolveThreadBranch(documentId, threadId): Promise<BranchState> {
      const row = await findActiveThreadPeer(documentId, threadId);
      if (!row) throw new BranchNotFoundError(documentId, threadId);
      return {
        branchId: row.branchId,
        doc: materializeBranch(row, threadId),
        generation: row.generation,
      };
    },

    async listActiveWorkDraftBranchIds(documentId) {
      const rows = await currentDrizzleDb(db)
        .select({ id: documentBranches.id })
        .from(documentBranches)
        .where(
          and(
            eq(documentBranches.documentId, documentId),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
          ),
        );
      return rows.map((row) => row.id);
    },

    ensureWorkDraftBranch(input) {
      return runInDrizzleTransaction(db, () => ensureWorkDraftBranch(input));
    },

    ensureThreadPeerBranch(input) {
      return runInDrizzleTransaction(db, () => ensureThreadPeerBranch(input));
    },

    ensureProjectManifest(input) {
      return ensureProjectManifest(input);
    },

    syncManifestToDocuments,
    resolveManifestMembership,
    recordManifestDocumentCreated: (documentId) => mutateLiveManifest(documentId, true),
    recordManifestDocumentDeleted: (documentId) => mutateLiveManifest(documentId, false),
  };
}

class BranchMutationRollback extends Error {}

type BranchSelectRow = Awaited<ReturnType<ReturnType<typeof selectBranch>["limit"]>>[number];

function selectBranch(db: DrizzleDb) {
  return db
    .select({
      branchId: documentBranches.id,
      documentId: documentBranches.documentId,
      kind: documentBranches.kind,
      upstreamBranchId: documentBranches.upstreamBranchId,
      workId: documentBranches.workId,
      threadId: documentBranches.threadId,
      pushPolicy: documentBranches.pushPolicy,
      status: documentBranches.status,
      generation: documentBranches.generation,
      state: documentBranches.state,
      stateVector: documentBranches.stateVector,
      schemaVersion: documentBranches.schemaVersion,
    })
    .from(documentBranches);
}

function mapBranch(row: BranchSelectRow): BranchSnapshot {
  return {
    branchId: row.branchId,
    documentId: row.documentId,
    kind: row.kind,
    upstreamBranchId: row.upstreamBranchId,
    workId: row.workId,
    threadId: row.threadId,
    pushPolicy: row.pushPolicy,
    status: row.status,
    generation: row.generation,
    state: row.state,
    stateVector: row.stateVector,
    schemaVersion: row.schemaVersion,
  };
}

function materializeBranch(row: BranchSnapshot, threadId: ThreadId): Y.Doc {
  assertReadableBranch(row);
  try {
    const doc = createCollabYDoc({ gc: false });
    Y.applyUpdate(doc, row.state);
    Y.encodeStateVector(doc);
    return doc;
  } catch (cause) {
    throw new BranchCorruptError({
      branchId: row.branchId,
      documentId: row.documentId,
      threadId,
      cause,
    });
  }
}

function hasYjsUpdate(update: Uint8Array): boolean {
  return update.length > 2;
}
