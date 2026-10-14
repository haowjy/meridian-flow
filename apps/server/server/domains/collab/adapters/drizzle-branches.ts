/** Drizzle persistence adapter for shadow branch peers. */

import { randomUUID } from "node:crypto";
import { UNKNOWN_BASE_REVISION } from "@meridian/agent-edit/diff";
import {
  captureEditParts,
  type DocumentLifecycle,
  type UpdateJournal,
} from "@meridian/agent-edit/integration";
import type { DraftId } from "@meridian/contracts";
import { isContextUriScheme } from "@meridian/contracts/context-uri";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branchPushSettlementBatches,
  branchPushSettlementOutbox,
  branchWriteJournal,
  documentBranches,
  documentYjsHeads,
  documentYjsUpdates,
  threadWorks,
} from "@meridian/database/schema";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  createCollabYDoc,
  packCollabSchemaVersion,
  unpackCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  isInDrizzleTransaction,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { lockThreadForMutation } from "../../../shared/thread-work-lock.js";
import {
  branchDraftWork,
  draftBranchWorks,
  runWithActiveWorkDrafts,
} from "../../../shared/work-draft-lifecycle.js";
import {
  draftMayHold,
  loadDocumentOwner,
  loadDraftHolder,
} from "../../context/tree/draft-ownership.js";
import { isDrafted } from "../../file-policy/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import {
  type AppendBranchJournalInput,
  assertReadableBranch,
  type BranchSnapshot,
  BranchStaleUpdateError,
  type CommitBranchMutationInput,
  type PersistBranchInput,
} from "../domain/branch-coordinator.js";
import { branchJournalRevision } from "../domain/branch-push-contracts.js";
import {
  BranchCorruptError,
  BranchNotFoundError,
  type BranchState,
} from "../domain/branch-resolver.js";
import { replicateFrozenIdentity } from "../domain/document-mutation-policy.js";
import { seedDraftState } from "../domain/draft-rebase.js";
import type { Drafts } from "../domain/drafts.js";
import type { PeerRetirementCause, RetiredBranch } from "../domain/peer-retirement.js";
import type { ApplicationBranchStore } from "../domain/ports/application-branch-store.js";
import { casBranchState } from "./drizzle-branch-state.js";
import { captureReceiptRows, recordDocumentEdit } from "./drizzle-document-edits.js";

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
      .values({
        ...values,
        hasEffect: false,
        schemaVersion: packCollabSchemaVersion(values.schemaVersion),
      })
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
      state: row.state,
      stateVector: row.stateVector,
      baseRevision: row.baseRevision,
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
    // The insert's own transaction holds D active (§2.1): a closed draft gains no branch.
    if (!(await drafts.shareActive(input.draftId))) {
      throw new BranchStaleUpdateError(`draft:${input.draftId}`);
    }
    await assertDraftableInDraft(input.documentId, input.draftId);
    // A text branch starts from fresh items holding live's text twice (draft and base), never from a copy
    // of live's Yjs state. Its base revision is unknown here (the caller's doc carries none): older than
    // every revision, so the first rebase reconciles whatever moved.
    const { state, stateVector } = seedDraftState(input.liveDoc);
    const seed = { state: Buffer.from(state), stateVector: Buffer.from(stateVector) };
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
        baseRevision: UNKNOWN_BASE_REVISION,
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
   * §12.5, O-11: a contribution is any journal row of the branch that
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
   * Callers route scratch and uploads live (D9), and pick a draft that may hold the
   * document (`draftMayHold`); reaching here otherwise is a routing or authorization bug.
   * Every draft branch is created here, so no entry point can pair a document with a
   * draft that may not hold it.
   */
  async function assertDraftableInDraft(documentId: DocumentId, draftId: DraftId): Promise<void> {
    const tx = currentDrizzleDb(db);
    const owner = await loadDocumentOwner(tx, documentId);
    if (owner && isContextUriScheme(owner.scheme) && !isDrafted(owner.scheme)) {
      throw new Error(`Document ${documentId} is in ${owner.scheme}://, which is never drafted`);
    }
    const holder = await loadDraftHolder(tx, draftId);
    if (!owner || !holder || !draftMayHold(holder, owner)) {
      throw new Error(`Draft ${draftId} may not hold document ${documentId}`);
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
    const ensurePeer = async (): Promise<BranchSnapshot> => {
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
            and(eq(documentBranches.id, existing.branchId), eq(documentBranches.status, "active")),
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
    };
    // Alone, the root transaction takes the thread lock itself: one connection, never a
    // lock-holding connection waiting for a second one from a drained pool.
    if (!isInDrizzleTransaction()) {
      return runInRootDrizzleTransaction(db, async () => {
        await lockThreadForMutation(db, input.threadId);
        return ensurePeer();
      });
    }
    return runInDrizzleTransaction(db, async () => {
      await lockThreadForMutation(db, input.threadId);
      // Keep authority stable with the caller's thread lock. The branch writes
      // commit independently; reacquiring this row in the root would self-deadlock.
      return runInRootDrizzleTransaction(db, ensurePeer);
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

  async function closeThreadPeersOf(
    upstreamBranchIds: readonly string[],
    cause: PeerRetirementCause,
  ): Promise<RetiredBranch[]> {
    if (upstreamBranchIds.length === 0) return [];
    const closed = await currentDrizzleDb(db)
      .update(documentBranches)
      .set({ status: "closed", updatedAt: new Date() })
      .where(
        and(
          inArray(documentBranches.upstreamBranchId, [...upstreamBranchIds]),
          eq(documentBranches.kind, "thread_peer"),
          eq(documentBranches.status, "active"),
        ),
      )
      .returning({
        branchId: documentBranches.id,
        documentId: documentBranches.documentId,
        threadId: documentBranches.threadId,
      });
    return closed.flatMap((branch) =>
      branch.threadId
        ? [
            {
              branchId: branch.branchId,
              documentId: branch.documentId as DocumentId,
              threadId: branch.threadId as ThreadId,
              cause,
            },
          ]
        : [],
    );
  }

  async function getBranchSnapshot(branchId: string): Promise<BranchSnapshot> {
    const [row] = await selectBranch(currentDrizzleDb(db))
      .where(eq(documentBranches.id, branchId))
      .limit(1);
    if (!row) throw new Error(`Branch ${branchId} does not exist`);
    return mapBranch(row);
  }

  /**
   * Every runtime write of a branch's state: the Work projection encloses the raw CAS (pending count
   * before, the CAS, pending count after, the projection change published in the same transaction), so a
   * write that moves `has_effect` is seen by the Work page and the catalog, not only by the count query.
   * With `journals`, the rows are checked against their preconditions first and written after the CAS
   * wins, so a lost write leaves nothing behind. Returns false when the CAS lost.
   */
  async function writeBranchState(
    tx: DrizzleDb,
    input: PersistBranchInput & { journals?: readonly AppendBranchJournalInput[] },
  ): Promise<boolean> {
    const journals = input.journals ?? [];
    if (journals.some((row) => row.branchId !== input.branchId)) return false;
    return mutatePending([input.branchId], async () => {
      for (const journal of journals) {
        if (journal.expectedJournalWatermark !== undefined) {
          const [head] = await tx
            .select({ id: sql<number>`coalesce(max(${branchWriteJournal.id}), 0)::bigint` })
            .from(branchWriteJournal)
            .where(and(eq(branchWriteJournal.branchId, journal.branchId)));
          if ((head?.id ?? 0) > journal.expectedJournalWatermark) return false;
        }
        if (journal.expectedJournalRevision !== undefined) {
          const rows = await tx
            .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
            .from(branchWriteJournal)
            .where(and(eq(branchWriteJournal.branchId, journal.branchId)))
            .orderBy(branchWriteJournal.id)
            .for("update");
          if (branchJournalRevision(rows) !== journal.expectedJournalRevision) return false;
        }
      }
      if (!(await casBranchState(tx, input))) return false;
      if (journals.length) {
        const rows = await tx
          .insert(branchWriteJournal)
          .values(
            journals.map((journal) => ({
              branchId: journal.branchId,
              updateData: Buffer.from(journal.updateData),
              draftBaseUpdateSeq: draftBaseForBranch(journal.branchId),
              source: journal.source,
              wId: journal.wId ?? null,
              toolCallId: journal.toolCallId ?? null,
              threadId: journal.threadId ?? null,
              turnId: journal.turnId ?? null,
              actorUserId: journal.actorUserId ?? null,
              updateMeta: journal.updateMeta ?? null,
            })),
          )
          .returning({ id: branchWriteJournal.id });
        const branch = await getBranchSnapshot(input.branchId);
        const doc = createCollabYDoc({ gc: false });
        Y.applyUpdate(doc, input.expectedState);
        try {
          await captureBranchEdits(tx, branch, doc, journals, rows);
        } finally {
          doc.destroy();
        }
      }
      return true;
    });
  }

  return {
    deferUntilCommit: deferUntilDrizzleCommit,

    async getBranch(branchId) {
      const [row] = await selectBranch(currentDrizzleDb(db))
        .where(eq(documentBranches.id, branchId))
        .limit(1);
      return row ? mapBranch(row) : null;
    },

    writeBranchState(input) {
      return writeBranchState(currentDrizzleDb(db), input);
    },

    async readRebaseCuts(branchId: string) {
      const [row] = await currentDrizzleDb(db)
        .select({ cuts: documentBranches.rebaseCuts })
        .from(documentBranches)
        .where(eq(documentBranches.id, branchId))
        .limit(1);
      return (row?.cuts ?? []).map((cut) => new Uint8Array(cut));
    },

    async updateBranchSnapshot(input: PersistBranchInput) {
      return runInDrizzleTransaction(db, () => writeBranchState(currentDrizzleDb(db), input));
    },

    async commitBranchMutation(input: CommitBranchMutationInput) {
      return runWithActiveWorkDrafts(db, { branchIds: [input.branchId] }, async () => {
        const editBranch = await getBranchSnapshot(input.branchId);
        await lockDocumentMutation(currentDrizzleDb(db), editBranch.documentId);
        return writeBranchState(currentDrizzleDb(db), input);
      });
    },

    async appendJournal(input: AppendBranchJournalInput) {
      await runWithActiveWorkDrafts(db, { branchIds: [input.branchId] }, async () => {
        await mutatePending([input.branchId], () =>
          currentDrizzleDb(db)
            .insert(branchWriteJournal)
            .values({
              branchId: input.branchId,
              updateData: Buffer.from(input.updateData),
              draftBaseUpdateSeq: draftBaseForBranch(input.branchId),
              source: input.source,
              wId: input.wId ?? null,
              toolCallId: input.toolCallId ?? null,
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
      };
    },

    async resolveDraftBranch(input): Promise<BranchState> {
      const [row] = await selectBranch(currentDrizzleDb(db))
        .where(
          and(
            eq(documentBranches.id, input.draftBranchId),
            eq(documentBranches.documentId, input.documentId),
            eq(documentBranches.draftId, input.draftId),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
          ),
        )
        .limit(1);
      if (!row) throw new BranchNotFoundError(input.documentId, "" as ThreadId);
      const branch = mapBranch(row);
      return {
        branchId: branch.branchId,
        doc: materializeBranch(branch, "" as ThreadId),
      };
    },

    async blockingApplySettlement(documentId) {
      const [row] = await currentDrizzleDb(db)
        .select({
          pushId: branchPushSettlementOutbox.pushId,
          state: branchPushSettlementBatches.state,
          ageMs: sql<number>`(extract(epoch from clock_timestamp() - ${branchPushSettlementOutbox.createdAt}) * 1000)::float8`,
        })
        .from(branchPushSettlementOutbox)
        .innerJoin(
          branchPushSettlementBatches,
          eq(branchPushSettlementBatches.id, branchPushSettlementOutbox.batchId),
        )
        .where(
          and(
            eq(branchPushSettlementOutbox.documentId, documentId),
            inArray(branchPushSettlementBatches.state, ["pending", "blocked"]),
          ),
        )
        .orderBy(branchPushSettlementOutbox.pushId)
        .limit(1);
      if (!row || (row.state !== "pending" && row.state !== "blocked")) return null;
      return { pushId: row.pushId, state: row.state, ageMs: Math.max(0, Number(row.ageMs)) };
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
    closeThreadPeersOf,

    ensureThreadPeerBranch(input) {
      return ensureThreadPeerBranch(input);
    },
  };
}

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
      state: documentBranches.state,
      stateVector: documentBranches.stateVector,
      baseRevision: documentBranches.baseRevision,
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
    state: row.state,
    stateVector: row.stateVector,
    baseRevision: row.baseRevision,
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

async function captureBranchEdits(
  db: Pick<Database, "select" | "insert" | "update">,
  branch: BranchSnapshot,
  doc: Y.Doc,
  journals: readonly AppendBranchJournalInput[],
  rows: readonly { id: number }[],
): Promise<void> {
  const groups = new Map<
    string,
    {
      journal: AppendBranchJournalInput;
      receipts: import("./drizzle-document-edits.js").ReceiptWrite["receipts"];
    }
  >();
  const captured = captureReceiptRows(
    doc,
    journals.map((journal, i) => ({
      update: journal.updateData,
      origin: {
        kind: "pending",
        branchId: branch.branchId,
        rowId: rows[i].id,
      },
    })),
  );
  for (const [i, journal] of journals.entries()) {
    const key = journal.documentEditKey ?? `${journal.threadId}:${journal.wId ?? rows[i].id}`;
    const group = groups.get(key) ?? { journal, receipts: [] };
    group.receipts.push(captured[i]);
    groups.set(key, group);
  }
  for (const { journal, receipts } of groups.values()) {
    const meta =
      journal.updateMeta && typeof journal.updateMeta === "object"
        ? (journal.updateMeta as Record<string, unknown>)
        : {};
    await recordDocumentEdit(db, {
      documentId: branch.documentId,
      wId: journal.wId ?? undefined,
      threadId: journal.threadId,
      turnId: journal.turnId as import("@meridian/contracts").TurnId | null | undefined,
      responseId:
        typeof meta.authoringResponseId === "string"
          ? (meta.authoringResponseId as import("@meridian/contracts").ModelResponseId)
          : undefined,
      editScopeId: typeof meta.editScopeId === "string" ? meta.editScopeId : undefined,
      actor: journal.source === "writer" ? "human" : journal.threadId ? "agent" : "system",
      actorUserId: journal.actorUserId as import("@meridian/contracts").UserId | null | undefined,
      receipts: captureEditParts(doc, receipts).map((p, i) => ({
        ...p,
        origin: receipts[i].origin,
      })),
    });
  }
}
