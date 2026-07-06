/** Drizzle persistence adapter for shadow branch peers and manifest peers. */
import { randomUUID } from "node:crypto";
import type { DocumentId, ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branchWriteJournal,
  contextSources,
  documentBranches,
  documents,
  documentYjsHeads,
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
  type PersistBranchInput,
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
      generation: row.generation,
      state: row.state,
      stateVector: row.stateVector,
      schemaVersion: COLLAB_SCHEMA_VERSION,
    });
  }

  function snapshotFromDoc(doc: Y.Doc): { state: Buffer; stateVector: Buffer } {
    return {
      state: Buffer.from(Y.encodeStateAsUpdate(doc)),
      stateVector: Buffer.from(Y.encodeStateVector(doc)),
    };
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
    const doc = createCollabYDoc({ gc: false });
    const map = doc.getMap<{ present: true }>("documents");
    for (const row of await listProjectManuscriptDocumentIds(input.projectId)) {
      map.set(row, { present: true });
    }
    return { documentId: documentId as DocumentId, doc };
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
          eq(documents.kind, "manuscript"),
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

  async function mutateLiveManifest(documentId: DocumentId, present: boolean): Promise<void> {
    // SHADOW-S1: while agent tools still read SQL membership, mirror shipped create/delete into the manifest peer.
    const projectId = await projectForDocument(documentId);
    if (!projectId) return;
    await ensureProjectManifest({ projectId }).then(({ doc }) => {
      const map = doc.getMap<{ present: true }>("documents");
      if (present) map.set(documentId, { present: true });
      else map.delete(documentId);
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
      generation: documentBranches.generation,
      state: documentBranches.state,
      stateVector: documentBranches.stateVector,
      schemaVersion: documentYjsHeads.schemaVersion,
    })
    .from(documentBranches)
    .leftJoin(documentYjsHeads, eq(documentYjsHeads.documentId, documentBranches.documentId));
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
