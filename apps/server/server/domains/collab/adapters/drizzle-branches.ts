/** Drizzle persistence adapter for shadow branch peers. */

import { randomUUID } from "node:crypto";
import type { DocumentLifecycle, UpdateJournal } from "@meridian/agent-edit/integration";
import type { DraftId } from "@meridian/contracts";
import { isContextUriScheme } from "@meridian/contracts/context-uri";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branchWriteJournal,
  contextSources,
  documentBranches,
  documents,
  documentYjsHeads,
  documentYjsUpdates,
  drafts as draftRows,
  threadWorks,
  works,
} from "@meridian/database/schema";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  createCollabYDoc,
  packCollabSchemaVersion,
  unpackCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { lockThreadForMutation } from "../../../shared/thread-work-lock.js";
import {
  branchDraftWork,
  draftBranchWorks,
  runWithActiveWorkDrafts,
} from "../../../shared/work-draft-lifecycle.js";
import { isDrafted } from "../../file-policy/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import {
  type AppendBranchJournalInput,
  assertReadableBranch,
  type BranchSnapshot,
  BranchStaleUpdateError,
  type CommitBranchMutationInput,
  type PersistBranchInput,
  type ResetBranchSnapshotInput,
} from "../domain/branch-coordinator.js";
import { branchJournalRevision } from "../domain/branch-push-contracts.js";
import {
  BranchCorruptError,
  BranchNotFoundError,
  type BranchState,
} from "../domain/branch-resolver.js";
import { replicateFrozenIdentity } from "../domain/document-mutation-policy.js";
import type { Drafts } from "../domain/drafts.js";
import type { ApplicationBranchStore } from "../domain/ports/application-branch-store.js";

export type DrizzleBranchStore = ApplicationBranchStore;

export function createDrizzleBranchStore(
  db: Database,
  deps: {
    live?: {
      journal: UpdateJournal;
      lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
    };
    workProjection?: WorkProjectionMutation;
    /** A peer ensure relies on its draft staying active; a thread finds its Work's draft. */
    drafts: Pick<Drafts, "shareActive" | "activeForWork">;
  },
): DrizzleBranchStore {
  const { live, workProjection, drafts } = deps;
  const mutatePending = <T>(branchIds: readonly string[], operation: () => Promise<T>) =>
    workProjection ? workProjection.mutatePendingBranches(branchIds, operation) : operation();
  async function findPrimaryWork(threadId: ThreadId): Promise<WorkId> {
    const [row] = await currentDrizzleDb(db)
      .select({ workId: threadWorks.workId })
      .from(threadWorks)
      .where(and(eq(threadWorks.threadId, threadId), eq(threadWorks.isPrimary, true)))
      .limit(1);
    if (!row) throw new NoPrimaryWorkError(threadId);
    return row.workId;
  }

  function draftBaseForBranch(branchId: string) {
    return sql<number>`coalesce((
      select max(${documentYjsUpdates.id})
      from ${documentYjsUpdates}
      where ${documentYjsUpdates.documentId} = (
        select ${documentBranches.documentId}
        from ${documentBranches}
        where ${documentBranches.id} = ${branchId}
      )
    ), 0)`;
  }

  function monotonicSchemaStamp(version = COLLAB_SCHEMA_VERSION) {
    const packedVersion = packCollabSchemaVersion(version);
    const packedRunningVersion = packCollabSchemaVersion(COLLAB_SCHEMA_VERSION);
    return sql<number>`greatest(
      ${documentBranches.schemaVersion},
      ${packedVersion},
      ${packedRunningVersion}
    )`;
  }

  async function activeDraftBranch(
    documentId: DocumentId,
    draftId: DraftId,
  ): Promise<BranchSnapshot | null> {
    const [row] = await selectBranch(currentDrizzleDb(db))
      .where(
        and(
          eq(documentBranches.documentId, documentId),
          eq(documentBranches.draftId, draftId),
          eq(documentBranches.kind, "work_draft"),
          eq(documentBranches.status, "active"),
        ),
      )
      .limit(1);
    return row ? mapBranch(row) : null;
  }

  async function insertBranch(
    values: Omit<typeof documentBranches.$inferInsert, "schemaVersion"> & {
      schemaVersion: CollabSchemaVersion;
    },
  ): Promise<BranchSnapshot> {
    const [row] = await currentDrizzleDb(db)
      .insert(documentBranches)
      .values({ ...values, schemaVersion: packCollabSchemaVersion(values.schemaVersion) })
      .returning();
    if (!row) throw new Error("Failed to create document branch");
    const [mapped] = await draftBranchWorks(db, [row.id]);
    return mapBranch({
      branchId: row.id,
      documentId: row.documentId,
      kind: row.kind,
      upstreamBranchId: row.upstreamBranchId,
      draftId: row.draftId,
      workId: mapped?.workId ?? null,
      threadId: row.threadId,
      status: row.status,
      generation: row.generation,
      state: row.state,
      stateVector: row.stateVector,
      discardedStateVector: row.discardedStateVector,
      schemaVersion: row.schemaVersion,
    });
  }

  function snapshotFromDoc(doc: Y.Doc): { state: Buffer; stateVector: Buffer } {
    return {
      state: Buffer.from(Y.encodeStateAsUpdate(doc)),
      stateVector: Buffer.from(Y.encodeStateVector(doc)),
    };
  }

  async function replicatedSnapshotFrom(source: Y.Doc): Promise<{
    state: Buffer;
    stateVector: Buffer;
  }> {
    const target = createCollabYDoc({ gc: false });
    const frozenSource = createCollabYDoc({ gc: false });
    Y.applyUpdate(frozenSource, Y.encodeStateAsUpdate(source));
    try {
      await replicateFrozenIdentity({
        source: { documentId: "new-branch", doc: frozenSource },
        target: { documentId: "new-branch", generation: 1n, doc: target },
        plan: { kind: "wholeDocument" },
        admit: async ({ update }) => {
          Y.applyUpdate(target, update);
          return { sequence: 1n, joined: 0 };
        },
      });
      return snapshotFromDoc(target);
    } finally {
      frozenSource.destroy();
      target.destroy();
    }
  }

  async function liveSchemaVersion(documentId: DocumentId): Promise<CollabSchemaVersion> {
    const [row] = await currentDrizzleDb(db)
      .select({ schemaVersion: documentYjsHeads.schemaVersion })
      .from(documentYjsHeads)
      .where(eq(documentYjsHeads.documentId, documentId))
      .limit(1);
    return row ? unpackCollabSchemaVersion(row.schemaVersion) : COLLAB_SCHEMA_VERSION;
  }

  async function ensureDraftBranch(input: {
    documentId: DocumentId;
    draftId: DraftId;
    liveDoc: Y.Doc;
  }): Promise<BranchSnapshot> {
    const existing = await activeDraftBranch(input.documentId, input.draftId);
    if (existing) return existing;
    await assertDraftableInDraft(input.documentId, input.draftId);
    const seed = await replicatedSnapshotFrom(input.liveDoc);
    // A draft create's ensure and a thread peer's racing root ensure get one branch.
    const [inserted] = await currentDrizzleDb(db)
      .insert(documentBranches)
      .values({
        id: `branch_${randomUUID()}`,
        documentId: input.documentId,
        kind: "work_draft",
        upstreamBranchId: null,
        draftId: input.draftId,
        threadId: null,
        status: "active",
        ...seed,
        schemaVersion: packCollabSchemaVersion(await liveSchemaVersion(input.documentId)),
      })
      .onConflictDoNothing()
      .returning({ id: documentBranches.id });
    const branch = await activeDraftBranch(input.documentId, input.draftId);
    if (!branch) {
      throw new Error(
        `Draft branch for ${input.documentId} ${inserted ? "vanished" : "was not inserted"}`,
      );
    }
    return branch;
  }

  /**
   * §12.5, O-11: a contribution is any journal row of the branch's current generation that
   * isn't discarded (pending, pushed, or awaiting a rollback); then the create stands.
   */
  async function retractCreatedDraftBranch(input: {
    documentId: DocumentId;
    draftId: DraftId;
  }): Promise<
    | { outcome: "stands" }
    | { outcome: "retracted"; deleted: readonly { branchId: string; threadId: ThreadId | null }[] }
  > {
    const tx = currentDrizzleDb(db);
    const drafted = await tx
      .select({
        id: documentBranches.id,
        generation: documentBranches.generation,
        threadId: documentBranches.threadId,
      })
      .from(documentBranches)
      .where(
        and(
          eq(documentBranches.documentId, input.documentId),
          eq(documentBranches.kind, "work_draft"),
          eq(documentBranches.status, "active"),
          eq(documentBranches.draftId, input.draftId),
        ),
      );
    const peers =
      drafted.length === 0
        ? []
        : await tx
            .select({
              id: documentBranches.id,
              generation: documentBranches.generation,
              threadId: documentBranches.threadId,
            })
            .from(documentBranches)
            .where(
              inArray(
                documentBranches.upstreamBranchId,
                drafted.map((branch) => branch.id),
              ),
            );
    const branches = [...peers, ...drafted];
    for (const branch of branches) {
      const [contribution] = await tx
        .select({ id: branchWriteJournal.id })
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, branch.id),
            eq(branchWriteJournal.generation, branch.generation),
            sql`${branchWriteJournal.status} <> 'discarded'`,
          ),
        )
        .limit(1);
      if (contribution) return { outcome: "stands" };
    }
    if (branches.length > 0) {
      await tx.delete(documentBranches).where(
        inArray(
          documentBranches.id,
          branches.map((branch) => branch.id),
        ),
      );
    }
    return {
      outcome: "retracted",
      deleted: branches.map((branch) => ({
        branchId: branch.id,
        threadId: (branch.threadId as ThreadId | null) ?? null,
      })),
    };
  }

  /** §6.2 step 5: seeded from the document's durable live state, read in this transaction. */
  async function ensureCreatedDraftBranch(input: {
    documentId: DocumentId;
    draftId: DraftId;
  }): Promise<void> {
    if (!live) throw new Error("A draft create's branch needs the collab live journal");
    await live.lifecycle.ensureDocument(input.documentId);
    const snapshot = await live.journal.read(input.documentId);
    const liveDoc = createCollabYDoc({ gc: false });
    try {
      if (snapshot.checkpoint) Y.applyUpdate(liveDoc, snapshot.checkpoint);
      for (const update of snapshot.updates) Y.applyUpdate(liveDoc, update.update);
      await ensureDraftBranch({ ...input, liveDoc });
    } finally {
      liveDoc.destroy();
    }
  }

  /**
   * Callers route scratch and uploads live (D9), and pick a draft of the document's own
   * project; reaching here otherwise is a routing or authorization bug. Every draft branch
   * is created here, so no entry point can pair a document with another project's draft.
   */
  async function assertDraftableInDraft(documentId: DocumentId, draftId: DraftId): Promise<void> {
    const sourceWork = alias(works, "source_work");
    const [row] = await currentDrizzleDb(db)
      .select({
        scheme: contextSources.slug,
        projectId: sql<
          string | null
        >`coalesce(${contextSources.projectId}, ${sourceWork.projectId})`,
      })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .leftJoin(sourceWork, eq(sourceWork.id, contextSources.workId))
      .where(eq(documents.id, documentId))
      .limit(1);
    if (row && isContextUriScheme(row.scheme) && !isDrafted(row.scheme)) {
      throw new Error(`Document ${documentId} is in ${row.scheme}://, which is never drafted`);
    }
    const [draft] = await currentDrizzleDb(db)
      .select({ projectId: draftRows.projectId })
      .from(draftRows)
      .where(eq(draftRows.id, draftId))
      .limit(1);
    if (!row || !draft || row.projectId !== draft.projectId) {
      throw new Error(`Draft ${draftId} cannot draft document ${documentId} outside its project`);
    }
  }

  /**
   * The thread's peer in the given draft (contract §2.5): never ensures a draft. The draft
   * is held `FOR SHARE` while the branches are made, so a close either waits for this to
   * commit or has already closed it (then the peer is stale). Locks no Work row.
   */
  async function ensureThreadPeerBranch(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: DraftId;
    liveDoc: Y.Doc;
  }): Promise<BranchSnapshot> {
    return runInDrizzleTransaction(db, async () => {
      await lockThreadForMutation(db, input.threadId);
      // Keep authority stable with the caller's thread lock. The branch writes
      // commit independently; reacquiring this row in the root would self-deadlock.
      return runInRootDrizzleTransaction(db, async () => {
        if (!(await drafts.shareActive(input.draftId))) {
          throw new BranchStaleUpdateError(`draft:${input.draftId}`);
        }
        const existing = await findActiveThreadPeer(input.documentId, input.threadId);
        if (existing?.draftId === input.draftId) return existing;
        if (existing) {
          await currentDrizzleDb(db)
            .update(documentBranches)
            .set({ status: "closed", updatedAt: new Date() })
            .where(
              and(
                eq(documentBranches.id, existing.branchId),
                eq(documentBranches.status, "active"),
              ),
            );
        }
        const workDraft = await ensureDraftBranch({
          documentId: input.documentId,
          draftId: input.draftId,
          liveDoc: input.liveDoc,
        });
        const upstreamDoc = materializeBranch(workDraft, input.threadId);
        try {
          return await insertBranch({
            id: `branch_${randomUUID()}`,
            documentId: input.documentId,
            kind: "thread_peer",
            upstreamBranchId: workDraft.branchId,
            draftId: input.draftId,
            threadId: input.threadId,
            status: "active",
            ...(await replicatedSnapshotFrom(upstreamDoc)),
            schemaVersion: workDraft.schemaVersion,
          });
        } finally {
          upstreamDoc.destroy();
        }
      });
    });
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

  async function discardActiveThreadPeerBranches(input: {
    documentId: DocumentId;
    threadId?: ThreadId | null;
  }): Promise<void> {
    const clauses = [
      eq(documentBranches.documentId, input.documentId),
      eq(documentBranches.kind, "thread_peer"),
      eq(documentBranches.status, "active"),
    ];
    if (input.threadId) clauses.push(eq(documentBranches.threadId, input.threadId));
    await currentDrizzleDb(db)
      .update(documentBranches)
      .set({ status: "closed", updatedAt: new Date() })
      .where(and(...clauses));
  }

  async function updateBranchSnapshot(input: PersistBranchInput): Promise<boolean> {
    const [row] = await currentDrizzleDb(db)
      .update(documentBranches)
      .set({
        state: Buffer.from(input.state),
        stateVector: Buffer.from(input.stateVector),
        schemaVersion: monotonicSchemaStamp(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentBranches.id, input.branchId),
          eq(documentBranches.status, "active"),
          eq(documentBranches.generation, input.expectedGeneration),
          eq(documentBranches.stateVector, Buffer.from(input.expectedStateVector)),
          eq(documentBranches.state, Buffer.from(input.expectedState)),
        ),
      )
      .returning({ id: documentBranches.id });
    return Boolean(row);
  }

  return {
    deferUntilCommit: deferUntilDrizzleCommit,

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
      return runWithActiveWorkDrafts(db, { branchIds: [input.branchId] }, async () => {
        if (input.journal && input.journal.generation !== input.expectedGeneration) {
          throw new BranchMutationRollback();
        }
        const ok = await updateBranchSnapshot(input);
        if (!ok) throw new BranchMutationRollback();
        if (input.journal?.expectedJournalWatermark !== undefined) {
          const [head] = await currentDrizzleDb(db)
            .select({ id: sql<number>`coalesce(max(${branchWriteJournal.id}), 0)::bigint` })
            .from(branchWriteJournal)
            .where(
              and(
                eq(branchWriteJournal.branchId, input.journal.branchId),
                eq(branchWriteJournal.generation, input.journal.generation),
              ),
            );
          if ((head?.id ?? 0) > input.journal.expectedJournalWatermark) {
            throw new BranchMutationRollback();
          }
        }
        if (input.journal?.expectedJournalRevision !== undefined) {
          const rows = await currentDrizzleDb(db)
            .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
            .from(branchWriteJournal)
            .where(
              and(
                eq(branchWriteJournal.branchId, input.journal.branchId),
                eq(branchWriteJournal.generation, input.journal.generation),
              ),
            )
            .orderBy(branchWriteJournal.id)
            .for("update");
          if (branchJournalRevision(rows) !== input.journal.expectedJournalRevision) {
            throw new BranchMutationRollback();
          }
        }
        const journal = input.journal;
        if (journal)
          await mutatePending([journal.branchId], () =>
            currentDrizzleDb(db)
              .insert(branchWriteJournal)
              .values({
                branchId: journal.branchId,
                generation: journal.generation,
                updateData: Buffer.from(journal.updateData),
                draftBaseUpdateSeq: draftBaseForBranch(journal.branchId),
                source: journal.source,
                wId: journal.wId ?? null,
                threadId: journal.threadId ?? null,
                turnId: journal.turnId ?? null,
                actorUserId: journal.actorUserId ?? null,
                updateMeta: journal.updateMeta ?? null,
              })
              .then(() => undefined),
          );
        return true;
      }).catch((cause) => {
        if (cause instanceof BranchMutationRollback) return false;
        throw cause;
      });
    },

    async resetBranchSnapshot(input: ResetBranchSnapshotInput) {
      return runInDrizzleTransaction(db, () =>
        mutatePending([input.branchId], async () => {
          const txDb = currentDrizzleDb(db);
          const [row] = await txDb
            .update(documentBranches)
            .set({
              generation: sql`${documentBranches.generation} + 1`,
              state: Buffer.from(input.state),
              stateVector: Buffer.from(input.stateVector),
              discardedStateVector: Buffer.from(input.discardedStateVector),
              schemaVersion: monotonicSchemaStamp(input.schemaVersion),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(documentBranches.id, input.branchId),
                eq(documentBranches.status, "active"),
                eq(documentBranches.generation, input.expectedGeneration),
                eq(documentBranches.stateVector, Buffer.from(input.expectedStateVector)),
                eq(documentBranches.state, Buffer.from(input.expectedState)),
              ),
            )
            .returning({ id: documentBranches.id });
          if (!row) return false;
          await txDb
            .update(branchWriteJournal)
            .set({ status: "discarded" })
            .where(
              and(
                eq(branchWriteJournal.branchId, input.branchId),
                eq(branchWriteJournal.generation, input.expectedGeneration),
                inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
              ),
            )
            .then(() => undefined);
          return true;
        }),
      );
    },

    async appendJournal(input: AppendBranchJournalInput) {
      await runWithActiveWorkDrafts(db, { branchIds: [input.branchId] }, async () => {
        await mutatePending([input.branchId], () =>
          currentDrizzleDb(db)
            .insert(branchWriteJournal)
            .values({
              branchId: input.branchId,
              generation: input.generation,
              updateData: Buffer.from(input.updateData),
              draftBaseUpdateSeq: draftBaseForBranch(input.branchId),
              source: input.source,
              wId: input.wId ?? null,
              threadId: input.threadId ?? null,
              turnId: input.turnId ?? null,
              actorUserId: input.actorUserId ?? null,
              updateMeta: input.updateMeta ?? null,
            })
            .then(() => undefined),
        );
      });
    },

    async resolveThreadBranch(documentId, threadId): Promise<BranchState> {
      const workId = await findPrimaryWork(threadId).catch((cause) => {
        if (cause instanceof NoPrimaryWorkError)
          throw new BranchNotFoundError(documentId, threadId);
        throw cause;
      });
      const row = await findActiveThreadPeer(documentId, threadId);
      if (!row || row.workId !== workId) throw new BranchNotFoundError(documentId, threadId);
      return {
        branchId: row.branchId,
        doc: materializeBranch(row, threadId),
        generation: row.generation,
      };
    },

    async resolveWorkDraftBranchForThread(documentId, threadId): Promise<BranchState> {
      let workId: WorkId;
      try {
        workId = await findPrimaryWork(threadId);
      } catch (cause) {
        if (cause instanceof NoPrimaryWorkError)
          throw new BranchNotFoundError(documentId, threadId);
        throw cause;
      }
      const draft = await drafts.activeForWork(workId);
      const row = draft ? await activeDraftBranch(documentId, draft.id) : null;
      if (!row) throw new BranchNotFoundError(documentId, threadId);
      return {
        branchId: row.branchId,
        doc: materializeBranch(row, threadId),
        generation: row.generation,
      };
    },

    async resolveDraftBranch(input): Promise<BranchState> {
      const row = await ensureDraftBranch(input);
      return {
        branchId: row.branchId,
        doc: materializeBranch(row, "" as ThreadId),
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

    async listActiveDraftBranchIds(draftId) {
      const rows = await currentDrizzleDb(db)
        .select({ id: documentBranches.id })
        .from(documentBranches)
        .where(and(eq(documentBranches.draftId, draftId), eq(documentBranches.status, "active")));
      return rows.map((row) => row.id);
    },

    ensureDraftBranch(input) {
      return runInDrizzleTransaction(db, () => ensureDraftBranch(input));
    },

    ensureCreatedDraftBranch,
    retractCreatedDraftBranch,

    ensureThreadPeerBranch(input) {
      return ensureThreadPeerBranch(input);
    },

    discardActiveThreadPeerBranches(input) {
      return discardActiveThreadPeerBranches(input);
    },
  };
}

class BranchMutationRollback extends Error {}

class NoPrimaryWorkError extends Error {
  constructor(readonly threadId: ThreadId) {
    super(`Thread ${threadId} is not linked to a primary work`);
    this.name = "NoPrimaryWorkError";
  }
}

type BranchSelectRow = Awaited<ReturnType<ReturnType<typeof selectBranch>["limit"]>>[number];

/** A branch row with its Work derived through its draft (contract §2.4). */
function selectBranch(db: DrizzleDb) {
  return db
    .select({
      branchId: documentBranches.id,
      documentId: documentBranches.documentId,
      kind: documentBranches.kind,
      upstreamBranchId: documentBranches.upstreamBranchId,
      draftId: documentBranches.draftId,
      workId: branchDraftWork.workId,
      threadId: documentBranches.threadId,
      status: documentBranches.status,
      generation: documentBranches.generation,
      state: documentBranches.state,
      stateVector: documentBranches.stateVector,
      discardedStateVector: documentBranches.discardedStateVector,
      schemaVersion: documentBranches.schemaVersion,
    })
    .from(documentBranches)
    .innerJoin(branchDraftWork.drafts, branchDraftWork.on);
}

function mapBranch(row: BranchSelectRow): BranchSnapshot {
  return {
    branchId: row.branchId,
    documentId: row.documentId,
    kind: row.kind,
    upstreamBranchId: row.upstreamBranchId,
    draftId: row.draftId,
    workId: (row.workId as WorkId | null) ?? null,
    threadId: row.threadId,
    status: row.status,
    generation: row.generation,
    state: row.state,
    stateVector: row.stateVector,
    discardedStateVector: row.discardedStateVector,
    schemaVersion: unpackCollabSchemaVersion(row.schemaVersion),
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
