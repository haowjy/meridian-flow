/** Drizzle persistence adapter for shadow branch peers and manifest peers. */
import { randomUUID } from "node:crypto";
import type { DocumentId, ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branchWriteJournal,
  contextSources,
  documentBranches,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
  manuscriptDocumentPredicate,
  threadWorks,
} from "@meridian/database/schema";
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
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
    recordManifestDocumentCreated(documentId: DocumentId): Promise<void>;
    recordManifestDocumentDeleted(documentId: DocumentId): Promise<void>;
  };

export function createDrizzleBranchStore(db: Database): DrizzleBranchStore {
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

  async function upsertLiveHead(
    txDb: DrizzleDb,
    documentId: DocumentId,
    input: {
      latestUpdateSeq?: number;
      latestStateVector?: Uint8Array | null;
      latestCheckpointId?: number | null;
    } = {},
  ): Promise<void> {
    await txDb
      .insert(documentYjsHeads)
      .values({
        documentId,
        schemaVersion: COLLAB_SCHEMA_VERSION,
        latestUpdateSeq: input.latestUpdateSeq ?? 0,
        latestStateVector: input.latestStateVector ? Buffer.from(input.latestStateVector) : null,
        latestCheckpointId: input.latestCheckpointId ?? null,
      })
      .onConflictDoUpdate({
        target: documentYjsHeads.documentId,
        set: {
          schemaVersion: sql`greatest(${documentYjsHeads.schemaVersion}, ${COLLAB_SCHEMA_VERSION})`,
          ...(input.latestUpdateSeq !== undefined
            ? { latestUpdateSeq: input.latestUpdateSeq }
            : {}),
          ...(input.latestStateVector !== undefined
            ? {
                latestStateVector: input.latestStateVector
                  ? Buffer.from(input.latestStateVector)
                  : null,
              }
            : {}),
          ...(input.latestCheckpointId !== undefined
            ? { latestCheckpointId: input.latestCheckpointId }
            : {}),
          updatedAt: sql`now()`,
        },
      });
  }

  async function loadLiveDoc(documentId: DocumentId): Promise<Y.Doc> {
    const txDb = currentDrizzleDb(db);
    const doc = createCollabYDoc({ gc: false });
    const [checkpoint] = await txDb
      .select({
        id: documentYjsCheckpoints.id,
        state: documentYjsCheckpoints.state,
        upToSeq: documentYjsCheckpoints.upToSeq,
      })
      .from(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.documentId, documentId))
      .orderBy(desc(documentYjsCheckpoints.id))
      .limit(1);
    if (checkpoint) Y.applyUpdate(doc, checkpoint.state);
    const updates = await txDb
      .select({ updateData: documentYjsUpdates.updateData })
      .from(documentYjsUpdates)
      .where(
        and(
          eq(documentYjsUpdates.documentId, documentId),
          gt(documentYjsUpdates.id, checkpoint?.upToSeq ?? 0),
        ),
      )
      .orderBy(asc(documentYjsUpdates.id));
    for (const update of updates) Y.applyUpdate(doc, update.updateData);
    return doc;
  }

  async function seedLiveManifestIfEmpty(
    documentId: DocumentId,
    projectId: ProjectId,
  ): Promise<void> {
    const txDb = currentDrizzleDb(db);
    const [existingCheckpoint] = await txDb
      .select({ id: documentYjsCheckpoints.id })
      .from(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.documentId, documentId))
      .limit(1);
    const [existingUpdate] = await txDb
      .select({ id: documentYjsUpdates.id })
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, documentId))
      .limit(1);
    if (existingCheckpoint || existingUpdate) return;

    const doc = createCollabYDoc({ gc: false });
    const map = doc.getMap<{ present: true }>("documents");
    for (const row of await listProjectManuscriptDocumentIds(projectId))
      map.set(row, { present: true });
    const state = Y.encodeStateAsUpdate(doc);
    const stateVector = Y.encodeStateVector(doc);
    const [checkpoint] = await txDb
      .insert(documentYjsCheckpoints)
      .values({
        documentId,
        state: Buffer.from(state),
        stateVector: Buffer.from(stateVector),
        upToSeq: 0,
        reason: "manifest-seed",
      })
      .returning({ id: documentYjsCheckpoints.id });
    if (!checkpoint) throw new Error("Failed to seed manifest checkpoint");
    await upsertLiveHead(txDb, documentId, {
      latestUpdateSeq: 0,
      latestStateVector: stateVector,
      latestCheckpointId: checkpoint.id,
    });
  }

  async function appendLiveManifestUpdate(
    documentId: DocumentId,
    update: Uint8Array,
    doc: Y.Doc,
  ): Promise<void> {
    const txDb = currentDrizzleDb(db);
    const [row] = await txDb
      .insert(documentYjsUpdates)
      .values({ documentId, updateData: Buffer.from(update), originType: "system" })
      .returning({ id: documentYjsUpdates.id });
    if (!row) throw new Error("Failed to append manifest update");
    await upsertLiveHead(txDb, documentId, {
      latestUpdateSeq: row.id,
      latestStateVector: Y.encodeStateVector(doc),
    });
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
    const documentId =
      existing?.id ?? (await createManifestIdentity(input.projectId, input.contextSourceId));
    await seedLiveManifestIfEmpty(documentId as DocumentId, input.projectId);
    return {
      documentId: documentId as DocumentId,
      doc: await loadLiveDoc(documentId as DocumentId),
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
    const manifest = await ensureProjectManifest({ projectId });
    const present = [...manifest.doc.getMap<{ present: true }>("documents").keys()].sort();
    return { documentId: manifest.documentId, members: present };
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
    // SHADOW-S1: while agent tools still read SQL membership, mirror shipped create/delete into the manifest peer.
    const projectId = await projectForDocument(documentId);
    if (!projectId) return;
    await runInDrizzleTransaction(db, async () => {
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
      await appendLiveManifestUpdate(
        manifest.documentId,
        Y.encodeStateAsUpdate(manifest.doc, before),
        manifest.doc,
      );
    });
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
      return runInDrizzleTransaction(db, () => ensureProjectManifest(input));
    },

    syncManifestToDocuments,
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
