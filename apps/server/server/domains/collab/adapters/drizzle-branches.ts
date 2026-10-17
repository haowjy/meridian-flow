/**
 * Drizzle persistence adapter for shadow branch peers. A branch is a checkpoint (`state`) plus
 * a journal tail (`branch_write_journal.id > checkpoint_seq`), fenced by `revision`: content is
 * read only through `readBranchAt`, and every write commits through `appendRows` or
 * `commitRewrite`.
 */

import { randomUUID } from "node:crypto";
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
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
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
import { branchDraftWork, runWithActiveWorkDrafts } from "../../../shared/work-draft-lifecycle.js";
import {
  draftMayHold,
  loadDocumentOwner,
  loadDraftHolder,
} from "../../context/tree/draft-ownership.js";
import { isDrafted } from "../../file-policy/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import {
  type AppendBranchJournalInput,
  type AppendRowsInput,
  type AppendRowsOutcome,
  assertReadableBranch,
  type BranchRead,
  type BranchReadSince,
  type BranchSnapshot,
  BranchStaleUpdateError,
  type BranchTailRow,
  type CommitRewriteInput,
  materializeBranchRead,
  mergeStateVectors,
  type RewriteFence,
  type RewriteOutcome,
  type RewritePolicy,
} from "../domain/branch-coordinator.js";
import { branchJournalRevision } from "../domain/branch-push-contracts.js";
import {
  BranchCorruptError,
  BranchNotFoundError,
  type BranchState,
} from "../domain/branch-resolver.js";
import { replicateFrozenIdentity } from "../domain/document-mutation-policy.js";
import type { Drafts } from "../domain/drafts.js";
import type { PeerRetirementCause, RetiredBranch } from "../domain/peer-retirement.js";
import type { ApplicationBranchStore } from "../domain/ports/application-branch-store.js";
import {
  captureReceiptRows,
  recordDocumentEdit,
  settleDraftGeneration,
} from "./drizzle-document-edits.js";
import { refreshDraftEffect } from "./drizzle-draft-effect.js";

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

  /**
   * Takes the draft's origin Work `FOR KEY SHARE` and reads whether the branch it is about to
   * create is frozen (archived, deleted or missing Work). Taken before the draft's share lock and
   * before any close or insert: it waits for an archive in flight, and holds the next one off
   * until this insert commits and that archive's freeze sees it.
   */
  async function lockOriginWorkForCreate(draftId: DraftId): Promise<boolean> {
    const tx = currentDrizzleDb(db);
    const [draft] = await tx
      .select({ workId: draftRows.originWorkId })
      .from(draftRows)
      .where(eq(draftRows.id, draftId))
      .limit(1);
    if (!draft?.workId) return true;
    const [work] = await tx
      .select({ archivedAt: works.archivedAt, deletedAt: works.deletedAt })
      .from(works)
      .where(eq(works.id, draft.workId))
      .for("key share");
    return !work || work.archivedAt !== null || work.deletedAt !== null;
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
    const frozen = await lockOriginWorkForCreate(input.draftId);
    // The insert's own transaction holds D active (§2.1): a closed draft gains no branch.
    if (!(await drafts.shareActive(input.draftId))) {
      throw new BranchStaleUpdateError(`draft:${input.draftId}`);
    }
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
        frozen,
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
   * The thread's peer in the given draft (contract §2.5): never ensures a draft. The order is
   * thread lock, origin Work `FOR KEY SHARE`, the draft `FOR SHARE`, then any close and insert,
   * so a close either waits for this to commit or has already closed it (then the peer is
   * stale), and an archive either waits or is seen. Returns the peer's content as it stands.
   */
  async function ensureThreadPeerBranch(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: DraftId;
    liveDoc: Y.Doc;
  }): Promise<{ branch: BranchSnapshot; state: Uint8Array }> {
    const ensurePeer = async (): Promise<{ branch: BranchSnapshot; state: Uint8Array }> => {
      const frozen = await lockOriginWorkForCreate(input.draftId);
      if (!(await drafts.shareActive(input.draftId))) {
        throw new BranchStaleUpdateError(`draft:${input.draftId}`);
      }
      const existing = await findActiveThreadPeer(input.documentId, input.threadId);
      if (existing?.draftId === input.draftId) {
        return { branch: existing, state: await encodedBranch(existing.branchId) };
      }
      if (existing) {
        await currentDrizzleDb(db)
          .update(documentBranches)
          .set({
            status: "closed",
            revision: sql`${documentBranches.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(eq(documentBranches.id, existing.branchId), eq(documentBranches.status, "active")),
          );
      }
      const workDraft = await ensureDraftBranch({
        documentId: input.documentId,
        draftId: input.draftId,
        liveDoc: input.liveDoc,
      });
      const upstreamDoc = await materializeResolved(workDraft.branchId, input.threadId);
      try {
        const seed = await replicatedSnapshotFrom(upstreamDoc);
        const [row] = await currentDrizzleDb(db)
          .insert(documentBranches)
          .values({
            id: `branch_${randomUUID()}`,
            documentId: input.documentId,
            kind: "thread_peer",
            upstreamBranchId: workDraft.branchId,
            draftId: input.draftId,
            threadId: input.threadId,
            status: "active",
            ...seed,
            hasEffect: false,
            frozen,
            schemaVersion: packCollabSchemaVersion(workDraft.schemaVersion),
          })
          .returning({ id: documentBranches.id });
        if (!row) throw new Error("Failed to create document branch");
        const branch = await getBranchSnapshot(row.id);
        return { branch, state: seed.state };
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

  async function encodedBranch(branchId: string): Promise<Uint8Array> {
    const read = await readBranchAt(currentDrizzleDb(db), branchId);
    if (!read) throw new Error(`Branch ${branchId} does not exist`);
    if (!read.tail.length && read.checkpoint) return read.checkpoint.state;
    const doc = materializeBranchRead(read);
    try {
      return Y.encodeStateAsUpdate(doc);
    } finally {
      doc.destroy();
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

  async function closeThreadPeersOf(
    upstreamBranchIds: readonly string[],
    cause: PeerRetirementCause,
  ): Promise<RetiredBranch[]> {
    if (upstreamBranchIds.length === 0) return [];
    const closed = await currentDrizzleDb(db)
      .update(documentBranches)
      .set({
        status: "closed",
        revision: sql`${documentBranches.revision} + 1`,
        updatedAt: new Date(),
      })
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

  /** The branch's content now, through the read seam. */
  async function materializeResolved(branchId: string, threadId: ThreadId): Promise<Y.Doc> {
    const read = await readBranchAt(currentDrizzleDb(db), branchId);
    if (!read) throw new Error(`Branch ${branchId} does not exist`);
    assertReadableBranch(read.branch);
    try {
      return materializeBranchRead(read);
    } catch (cause) {
      throw new BranchCorruptError({
        branchId: read.branch.branchId,
        documentId: read.branch.documentId,
        threadId,
        cause,
      });
    }
  }

  /**
   * Shape A: rows appended past the checkpoint under `revision = expectedRevision`. The Work
   * lifecycle lock, the pending projection and the live advisory lock are taken as before the
   * store had a tail; ids are allocated after the branch row is locked.
   */
  async function appendRows(input: AppendRowsInput): Promise<AppendRowsOutcome> {
    return runWithActiveWorkDrafts(db, { branchIds: [input.branchId] }, () =>
      mutatePending([input.branchId], async () => {
        const tx = currentDrizzleDb(db);
        const branch = await getBranchSnapshot(input.branchId);
        await lockDocumentMutation(tx, branch.documentId);
        if (
          input.rows.some(
            (row) => row.generation !== input.expectedGeneration || row.branchId !== input.branchId,
          )
        )
          throw new BranchWriteRollback();
        const [locked] = await tx
          .update(documentBranches)
          .set({
            revision: sql`${documentBranches.revision} + 1`,
            schemaVersion: monotonicSchemaStamp(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documentBranches.id, input.branchId),
              eq(documentBranches.status, "active"),
              eq(documentBranches.generation, input.expectedGeneration),
              eq(documentBranches.revision, input.expectedRevision),
            ),
          )
          .returning({ revision: documentBranches.revision });
        if (!locked) throw new BranchWriteRollback();
        await checkJournalExpectations(tx, input.rows);
        const rowIds = await insertJournalRows(tx, input.rows);
        const effect = await refreshDraftEffect(tx, input.branchId);
        if (rowIds.length) {
          const doc = createCollabYDoc({ gc: false });
          Y.applyUpdate(doc, input.receiptBase);
          try {
            await captureBranchEdits(tx, branch, doc, input.rows, rowIds);
          } finally {
            doc.destroy();
          }
        }
        return {
          status: "appended" as const,
          revision: effect?.revision ?? locked.revision,
          rowIds,
        };
      }),
    ).catch((cause) => {
      if (cause instanceof BranchWriteRollback) return { status: "moved" as const };
      throw cause;
    });
  }

  /**
   * Shape B with the locks each rewrite took before the store had a tail: a checkpoint under
   * the Work lifecycle lock and the live advisory lock, a pull and a reset without them.
   */
  async function commitRewrite(input: CommitRewriteInput): Promise<RewriteOutcome> {
    const { operation } = input;
    const rewrite = async (): Promise<RewriteOutcome> => {
      const tx = currentDrizzleDb(db);
      let branch: BranchSnapshot | undefined;
      if (operation.kind === "checkpoint") {
        branch = await getBranchSnapshot(input.branchId);
        await lockDocumentMutation(tx, branch.documentId);
      }
      const rows = operation.kind === "checkpoint" ? (operation.rows ?? []) : [];
      let rowIds: number[] = [];
      const outcome = await commitRewriteWithinTx(tx, {
        branchId: input.branchId,
        policy: input.policy,
        fence: input.fence,
        ...(input.upstream ? { upstream: input.upstream } : {}),
        doc: input.doc,
        ...(operation.kind === "reset"
          ? {
              reset: { kind: "discard" as const, editDisposition: operation.editDisposition },
              schemaVersion: operation.schemaVersion,
            }
          : {}),
        withinLock: rows.length
          ? async () => {
              if (rows.some((row) => row.branchId !== input.branchId))
                throw new BranchWriteRollback();
              await checkJournalExpectations(tx, rows);
              rowIds = await insertJournalRows(tx, rows);
            }
          : undefined,
      });
      if (outcome.status !== "committed") throw new BranchWriteRollback(outcome);
      let revision = outcome.revision;
      // A compaction leaves the content, so the effect, as it was.
      if (operation.kind !== "reset" && operation.kind !== "compact") {
        const effect = await refreshDraftEffect(
          tx,
          input.branchId,
          operation.kind === "pull" ? operation.liveCut : undefined,
        );
        if (effect) revision = effect.revision;
      }
      if (branch && rowIds.length && operation.kind === "checkpoint" && operation.receiptBase) {
        const doc = createCollabYDoc({ gc: false });
        Y.applyUpdate(doc, operation.receiptBase);
        try {
          await captureBranchEdits(tx, branch, doc, rows, rowIds);
        } finally {
          doc.destroy();
        }
      }
      return {
        status: "committed",
        revision,
        checkpointRevision: outcome.checkpointRevision,
        seq: outcome.seq,
        generation: outcome.generation,
      };
    };
    const run =
      operation.kind === "checkpoint"
        ? () =>
            runWithActiveWorkDrafts(db, { branchIds: [input.branchId] }, () =>
              mutatePending([input.branchId], rewrite),
            )
        : operation.kind === "compact"
          ? () => runInDrizzleTransaction(db, rewrite)
          : () => runInDrizzleTransaction(db, () => mutatePending([input.branchId], rewrite));
    return run().catch((cause) => {
      if (cause instanceof BranchWriteRollback) return cause.outcome;
      throw cause;
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

    readBranchAt(branchId, since) {
      return readBranchAt(currentDrizzleDb(db), branchId, since);
    },

    appendRows,
    commitRewrite,

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
        doc: await materializeResolved(row.branchId, threadId),
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
        doc: await materializeResolved(row.branchId, threadId),
        generation: row.generation,
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
        doc: await materializeResolved(branch.branchId, "" as ThreadId),
        generation: branch.generation,
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
    closeThreadPeersOf,

    ensureThreadPeerBranch(input) {
      return ensureThreadPeerBranch(input);
    },
  };
}

/** A commit that must not stand: thrown inside the write's transaction to roll it back. */
class BranchWriteRollback extends Error {
  constructor(readonly outcome: RewriteOutcome = { status: "moved" }) {
    super(`Branch write rolled back: ${outcome.status}`);
  }
}

class NoPrimaryWorkError extends Error {
  constructor(readonly threadId: ThreadId) {
    super(`Thread ${threadId} is not linked to a primary work`);
    this.name = "NoPrimaryWorkError";
  }
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

async function insertJournalRows(
  db: DrizzleDb,
  rows: readonly AppendBranchJournalInput[],
): Promise<number[]> {
  if (!rows.length) return [];
  const inserted = await db
    .insert(branchWriteJournal)
    .values(
      rows.map((journal) => ({
        branchId: journal.branchId,
        generation: journal.generation,
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
  return inserted.map((row) => row.id);
}

/** A staged reversal's planning fences, checked under the branch row lock. */
async function checkJournalExpectations(
  db: DrizzleDb,
  rows: readonly AppendBranchJournalInput[],
): Promise<void> {
  for (const journal of rows) {
    if (journal.expectedJournalWatermark !== undefined) {
      const [head] = await db
        .select({ id: sql<number>`coalesce(max(${branchWriteJournal.id}), 0)::bigint` })
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, journal.branchId),
            eq(branchWriteJournal.generation, journal.generation),
          ),
        );
      if (Number(head?.id ?? 0) > journal.expectedJournalWatermark) {
        throw new BranchWriteRollback();
      }
    }
    if (journal.expectedJournalRevision !== undefined) {
      const rows = await db
        .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, journal.branchId),
            eq(branchWriteJournal.generation, journal.generation),
          ),
        )
        .orderBy(branchWriteJournal.id)
        .for("update");
      if (branchJournalRevision(rows) !== journal.expectedJournalRevision) {
        throw new BranchWriteRollback();
      }
    }
  }
}

type BranchSelectRow = Awaited<ReturnType<ReturnType<typeof selectBranch>["limit"]>>[number];

const branchColumns = {
  branchId: documentBranches.id,
  documentId: documentBranches.documentId,
  kind: documentBranches.kind,
  upstreamBranchId: documentBranches.upstreamBranchId,
  draftId: documentBranches.draftId,
  workId: branchDraftWork.workId,
  threadId: documentBranches.threadId,
  status: documentBranches.status,
  generation: documentBranches.generation,
  revision: documentBranches.revision,
  checkpointRevision: documentBranches.checkpointRevision,
  checkpointSeq: documentBranches.checkpointSeq,
  frozen: documentBranches.frozen,
  hasEffect: documentBranches.hasEffect,
  blocking: documentBranches.blocking,
  discardedStateVector: documentBranches.discardedStateVector,
  schemaVersion: documentBranches.schemaVersion,
};

/** A branch row with its Work derived through its draft (contract §2.4); no content. */
function selectBranch(db: DrizzleDb) {
  return db
    .select(branchColumns)
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
    revision: Number(row.revision),
    checkpointRevision: Number(row.checkpointRevision),
    checkpointSeq: Number(row.checkpointSeq),
    frozen: row.frozen,
    hasEffect: row.hasEffect,
    blocking: row.blocking,
    discardedStateVector: row.discardedStateVector,
    schemaVersion: unpackCollabSchemaVersion(row.schemaVersion),
  };
}

/**
 * The read seam: the branch row, its checkpoint and its tail (`id > checkpoint_seq` of the
 * current generation) from one statement, so one snapshot. With `since` naming the checkpoint
 * the caller still holds, the checkpoint bytes are left out and the tail starts after its seq.
 * Nothing else reads `document_branches.state`.
 */
export async function readBranchAt(
  db: DrizzleDb,
  branchId: string,
  since?: BranchReadSince,
): Promise<BranchRead | null> {
  const sinceRevision = since?.checkpointRevision ?? -1;
  const sinceSeq = since?.seq ?? 0;
  const held = sql`${documentBranches.checkpointRevision} = ${sinceRevision}`;
  const [row] = await db
    .select({
      ...branchColumns,
      state: sql<Buffer | null>`case when ${held} then null else ${documentBranches.state} end`,
      stateVector: sql<Buffer | null>`case when ${held} then null else ${documentBranches.stateVector} end`,
      tail: sql<{ id: number; update: string; source: "agent" | "writer" }[]>`(
        select coalesce(json_agg(json_build_object(
          'id', j.id, 'update', encode(j.update_data, 'base64'), 'source', j.source
        ) order by j.id), '[]'::json)
        from ${branchWriteJournal} j
        where j.branch_id = ${documentBranches.id}
          and j.generation = ${documentBranches.generation}
          and j.id > case when ${held}
            then greatest(${sinceSeq}::bigint, ${documentBranches.checkpointSeq})
            else ${documentBranches.checkpointSeq} end
      )`,
    })
    .from(documentBranches)
    .innerJoin(branchDraftWork.drafts, branchDraftWork.on)
    .where(eq(documentBranches.id, branchId))
    .limit(1);
  if (!row) return null;
  const tail: BranchTailRow[] = (row.tail ?? []).map((entry) => ({
    id: Number(entry.id),
    update: new Uint8Array(Buffer.from(entry.update, "base64")),
    source: entry.source,
  }));
  return {
    branch: mapBranch(row),
    checkpoint:
      row.state && row.stateVector
        ? { state: new Uint8Array(row.state), stateVector: new Uint8Array(row.stateVector) }
        : null,
    tail,
  };
}

export type RewriteCommit = {
  branchId: string;
  policy: RewritePolicy;
  fence: RewriteFence;
  /** A peer's captured upstream: locked `FOR SHARE` before the peer row, then checked. */
  upstream?: { branchId: string; generation: number };
  /** The new checkpoint. Under `fold`, a pull applies the tail into it. */
  doc: Y.Doc;
  /**
   * A re-fork to the next generation; the discarded vector gains the checkpoint's clocks and
   * every tail row's insertion clocks. `discard` also discards the generation's pending rows
   * and settles its edit parts; `refork` leaves both to the caller.
   */
  reset?: { kind: "discard"; editDisposition: "discarded" | "retired" } | { kind: "refork" };
  schemaVersion?: CollabSchemaVersion;
  /** Writes under the locked row before the checkpoint `UPDATE` (rows the checkpoint contains). */
  withinLock?: () => Promise<void>;
};

/**
 * Shape B, the one checkpoint door, inside the caller's transaction: lock the upstream
 * (`FOR SHARE`) then the branch row (`FOR UPDATE`), validate the policy and the fence, fold
 * the tail, write the checkpoint at `revision + 1` with `checkpoint_seq` covering every row
 * the branch now has. No compute beyond the fold runs under the lock.
 */
export async function commitRewriteWithinTx(
  db: DrizzleDb,
  input: RewriteCommit,
): Promise<RewriteOutcome> {
  if (input.upstream) {
    const [upstream] = await db
      .select({ status: documentBranches.status, generation: documentBranches.generation })
      .from(documentBranches)
      .where(eq(documentBranches.id, input.upstream.branchId))
      .for("share");
    if (upstream?.status !== "active" || upstream.generation !== input.upstream.generation)
      return { status: "upstreamMoved" };
  }
  const [locked] = await db
    .select({
      documentId: documentBranches.documentId,
      revision: documentBranches.revision,
      checkpointRevision: documentBranches.checkpointRevision,
      checkpointSeq: documentBranches.checkpointSeq,
      status: documentBranches.status,
      generation: documentBranches.generation,
      stateVector: documentBranches.stateVector,
      discardedStateVector: documentBranches.discardedStateVector,
    })
    .from(documentBranches)
    .where(eq(documentBranches.id, input.branchId))
    .for("update");
  if (locked?.status !== "active") return { status: "closed" };
  const moved =
    input.policy.kind === "exact"
      ? Number(locked.revision) !== input.policy.revision
      : Number(locked.checkpointRevision) !== input.policy.checkpointRevision;
  if (moved) return { status: "moved" };
  if (await fenced(db, input.fence, locked.documentId)) return { status: "fenced" };

  // Every row past the checkpoint; under `exact` these are exactly the rows the caller read.
  // Only a fold applies them and only a reset fences their clocks.
  const tail =
    !input.reset && input.policy.kind === "exact"
      ? []
      : await db
          .select({
            id: branchWriteJournal.id,
            update: branchWriteJournal.updateData,
            source: branchWriteJournal.source,
          })
          .from(branchWriteJournal)
          .where(
            and(
              eq(branchWriteJournal.branchId, input.branchId),
              eq(branchWriteJournal.generation, locked.generation),
              gt(branchWriteJournal.id, Number(locked.checkpointSeq)),
            ),
          )
          .orderBy(asc(branchWriteJournal.id));
  if (input.policy.kind === "fold" && !input.reset) {
    const after = input.policy.seq;
    for (const row of tail) {
      if (row.id <= after) continue;
      if (row.source === "agent") assertFreshAgentRow(input.doc, row.update);
      Y.applyUpdate(input.doc, row.update);
    }
  }
  const state = Buffer.from(Y.encodeStateAsUpdate(input.doc));
  const stateVector = Buffer.from(Y.encodeStateVector(input.doc));
  await input.withinLock?.();

  const reset = input.reset
    ? {
        generation: sql`${documentBranches.generation} + 1`,
        hasEffect: false,
        blocking: false,
        liveCut: state,
        discardedStateVector: Buffer.from(
          tail.reduce(
            (vector, row) => {
              const to = Y.parseUpdateMeta(row.update).to;
              return to.size ? mergeStateVectors(vector, Y.encodeStateVector(to)) : vector;
            },
            mergeStateVectors(locked.discardedStateVector, locked.stateVector),
          ),
        ),
      }
    : {};
  const [written] = await db
    .update(documentBranches)
    .set({
      state,
      stateVector,
      checkpointSeq: sql`(select coalesce(max(${branchWriteJournal.id}), 0) from ${branchWriteJournal} where ${branchWriteJournal.branchId} = ${input.branchId})`,
      revision: sql`${documentBranches.revision} + 1`,
      checkpointRevision: sql`${documentBranches.revision} + 1`,
      schemaVersion: monotonicSchemaStamp(input.schemaVersion),
      updatedAt: new Date(),
      ...reset,
    })
    .where(eq(documentBranches.id, input.branchId))
    .returning({
      revision: documentBranches.revision,
      checkpointRevision: documentBranches.checkpointRevision,
      checkpointSeq: documentBranches.checkpointSeq,
      generation: documentBranches.generation,
    });
  if (!written) throw new Error(`Branch ${input.branchId} vanished under its row lock`);
  if (input.reset?.kind === "discard") {
    await db
      .update(branchWriteJournal)
      .set({ status: "discarded" })
      .where(
        and(
          eq(branchWriteJournal.branchId, input.branchId),
          eq(branchWriteJournal.generation, locked.generation),
          inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
        ),
      );
    await settleDraftGeneration(db, input.branchId, locked.generation, input.reset.editDisposition);
  }
  return {
    status: "committed",
    revision: Number(written.revision),
    checkpointRevision: Number(written.checkpointRevision),
    seq: Number(written.checkpointSeq),
    generation: written.generation,
  };
}

async function fenced(db: DrizzleDb, fence: RewriteFence, documentId: string): Promise<boolean> {
  if (fence.kind !== "pending-settlement") return false;
  const [pending] = await db
    .select({ id: branchPushSettlementOutbox.pushId })
    .from(branchPushSettlementOutbox)
    .innerJoin(
      branchPushSettlementBatches,
      eq(branchPushSettlementBatches.id, branchPushSettlementOutbox.batchId),
    )
    .where(
      and(
        eq(branchPushSettlementOutbox.documentId, documentId as DocumentId),
        inArray(branchPushSettlementBatches.state, ["pending", "blocked"]),
      ),
    )
    .limit(1);
  return Boolean(pending);
}

/**
 * A change to a review-membership input (`blocking`, a journal row's status, `has_effect`)
 * outside a content write: the branch rows are locked in id order and their `revision` bumped
 * before the input changes, so a write judged at the old revision cannot commit over it.
 */
export async function bumpBranchRevisions(
  db: DrizzleDb,
  branchIds: readonly string[],
  set: { blocking?: boolean } = {},
): Promise<string[]> {
  const ids = [...new Set(branchIds)].sort();
  if (!ids.length) return [];
  const changed =
    set.blocking === undefined
      ? undefined
      : sql`${documentBranches.blocking} IS DISTINCT FROM ${set.blocking}`;
  const locked = await db
    .select({ id: documentBranches.id })
    .from(documentBranches)
    .where(and(inArray(documentBranches.id, ids), changed))
    .orderBy(asc(documentBranches.id))
    .for("update");
  if (!locked.length) return [];
  const lockedIds = locked.map((row) => row.id);
  await db
    .update(documentBranches)
    .set({ ...set, revision: sql`${documentBranches.revision} + 1` })
    .where(inArray(documentBranches.id, lockedIds));
  return lockedIds;
}

/** Draft agent rows own fresh structs; deletes may refer to older clients. */
function assertFreshAgentRow(doc: Y.Doc, update: Uint8Array): void {
  const clients = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const struct of Y.decodeUpdate(update).structs) {
    if (clients.has(struct.id.client))
      throw new Error(`Agent segment reused client ${struct.id.client}`);
  }
}

async function captureBranchEdits(
  db: Pick<Database, "select" | "insert" | "update">,
  branch: BranchSnapshot,
  doc: Y.Doc,
  journals: readonly AppendBranchJournalInput[],
  rowIds: readonly number[],
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
        generation: branch.generation,
        rowId: rowIds[i],
      },
    })),
  );
  for (const [i, journal] of journals.entries()) {
    const key = journal.documentEditKey ?? `${journal.threadId}:${journal.wId ?? rowIds[i]}`;
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
