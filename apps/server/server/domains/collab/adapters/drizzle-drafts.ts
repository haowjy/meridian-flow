/**
 * The application draft store over Drizzle: draft creation and resolution, and the
 * application half of each write (Work admission, the pending projection, the projection's
 * effect write and edit receipts) around the storage primitives in `drizzle-draft-storage`.
 */

import { randomUUID } from "node:crypto";
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import { isContextUriScheme } from "@meridian/contracts/context-uri";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentDrafts, draftWriteJournal, threadWorks } from "@meridian/database/schema";
import {
  COLLAB_SCHEMA_VERSION,
  createCollabYDoc,
  packCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  deferUntilDrizzleRollback,
  isInDrizzleTransaction,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import { lockThreadForMutation } from "../../../shared/thread-work-lock.js";
import {
  branchMayHold,
  loadBranchHolder,
  loadDocumentOwner,
} from "../../context/tree/branch-ownership.js";
import { requireLivingDocument } from "../../context/tree/living-document.js";
import { isDrafted } from "../../file-policy/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Branches } from "../domain/branches.js";
import { replicateFrozenSource } from "../domain/document-mutation-policy.js";
import { DraftNotFoundError, type ResolvedDraft } from "../domain/draft-resolver.js";
import type { DraftCloseCause } from "../domain/draft-retirement.js";
import {
  type AppendDraftJournalInput,
  type AppendReceiptGroup,
  type AppendRowsInput,
  type AppendRowsOutcome,
  type CommitRewriteInput,
  type DraftSnapshot,
  DraftStaleUpdateError,
  materializeDraftRead,
  type RewriteOutcome,
  type StaleEffectCursor,
} from "../domain/draft-store.js";
import type { ApplicationDraftStore } from "../domain/ports/application-draft-store.js";
import { findHeadSchemaVersion } from "./drizzle-document-authority-head.js";
import { recordDocumentEdit } from "./drizzle-document-edits.js";
import { type DraftClose, lockActiveDrafts } from "./drizzle-draft-close.js";
import {
  appendRowsWithinTx,
  commitRewriteWithinTx,
  DraftWriteRollback,
  mapDraft,
  readDraftAt,
  readEffectBaselineWithin,
  selectDraft,
} from "./drizzle-draft-storage.js";

export type RewriteCommitted = {
  draftId: string;
  rewrite: CommitRewriteInput["operation"]["kind"];
  holdMs: number;
  tailRows: number;
};

/**
 * An append committed: how long its `UPDATE` waited for the draft row (`waitMs`), how long it
 * then held the row to `COMMIT` (`holdMs`), the rows it wrote and the rows that landed between
 * its base and its lock.
 */
export type AppendCommitted = {
  draftId: string;
  waitMs: number;
  holdMs: number;
  rows: number;
  prefixRows: number;
  prefixMoved: boolean;
};

/** The projection write's bound on each lock acquisition, not on the transaction (G5, C1). */
const EFFECT_WRITE_LOCK_TIMEOUT = "100ms";

export function createDrizzleDraftStore(
  db: Database,
  deps: {
    live?: { journal: UpdateJournal };
    /** The one owner of Work-first order and the Works' projection (decision D17). */
    workProjection: WorkProjectionMutation;
    /** Every close retires what it closed after commit. */
    close: DraftClose;
    /** A peer ensure relies on its branch staying active; a thread finds its Work's branch. */
    branches: Pick<Branches, "shareActive" | "activeForWork">;
    /** A `commitRewrite` committed: the row lock's hold (`FOR UPDATE` → `COMMIT`) and its tail. */
    onRewriteCommitted?: (detail: RewriteCommitted) => void;
    /** An `appendRows` committed: its wait for the row lock and its hold to `COMMIT`. */
    onAppendSequenced?: (detail: AppendCommitted) => void;
  },
): ApplicationDraftStore {
  const { live, workProjection, branches, onRewriteCommitted, onAppendSequenced } = deps;
  async function findPrimaryWork(threadId: ThreadId): Promise<WorkId> {
    const [row] = await currentDrizzleDb(db)
      .select({ workId: threadWorks.workId })
      .from(threadWorks)
      .where(and(eq(threadWorks.threadId, threadId), eq(threadWorks.isPrimary, true)))
      .limit(1);
    if (!row) throw new NoPrimaryWorkError(threadId);
    return row.workId;
  }

  async function activeDocumentDraft(
    documentId: DocumentId,
    branchId: BranchId,
  ): Promise<DraftSnapshot | null> {
    const [row] = await selectDraft(currentDrizzleDb(db))
      .where(
        and(
          eq(documentDrafts.documentId, documentId),
          eq(documentDrafts.branchId, branchId),
          eq(documentDrafts.kind, "work_draft"),
          eq(documentDrafts.status, "active"),
        ),
      )
      .limit(1);
    return row ? mapDraft(row) : null;
  }

  function snapshotFromDoc(doc: Y.Doc): { state: Buffer; stateVector: Buffer } {
    return {
      state: Buffer.from(Y.encodeStateAsUpdate(doc)),
      stateVector: Buffer.from(Y.encodeStateVector(doc)),
    };
  }

  function replicatedSnapshotFrom(source: Y.Doc): { state: Buffer; stateVector: Buffer } {
    const target = createCollabYDoc({ gc: false });
    try {
      replicateFrozenSource(source, target);
      return snapshotFromDoc(target);
    } finally {
      target.destroy();
    }
  }

  async function ensureDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
    liveDoc: Y.Doc;
  }): Promise<DraftSnapshot> {
    const current = await activeDocumentDraft(input.documentId, input.branchId);
    if (current) return current;
    const seed = replicatedSnapshotFrom(input.liveDoc);
    // Creating a draft is a write the Work's lifecycle orders (decision D12): the branch's
    // Work is locked first, so an Archive either fences the new draft or committed before it.
    // A fresh fork has no effect against its seed, its baseline (`live_cut`), and the judgement
    // is fresh at revision 0: the baseline is frozen here and replaced only under a bump.
    return workProjection.mutate({ branches: [input.branchId] }, async () => {
      // The insert's own transaction holds D active (§2.1): a closed branch gains no draft.
      if (!(await branches.shareActive(input.branchId))) {
        throw new DraftStaleUpdateError(`Branch ${input.branchId}`);
      }
      await lockDocumentMutation(currentDrizzleDb(db), input.documentId);
      await requireLivingDocument(currentDrizzleDb(db), input.documentId);
      await testHook("draft.ensure.afterDocumentLock");
      const existing = await activeDocumentDraft(input.documentId, input.branchId);
      if (existing) return existing;
      await assertDraftableInBranch(input.documentId, input.branchId);
      // A document create's ensure and a thread peer's racing root ensure get one draft.
      const [inserted] = await currentDrizzleDb(db)
        .insert(documentDrafts)
        .values({
          id: `draft_${randomUUID()}`,
          documentId: input.documentId,
          kind: "work_draft",
          upstreamDraftId: null,
          branchId: input.branchId,
          threadId: null,
          status: "active",
          ...seed,
          liveCut: seed.state,
          hasEffect: false,
          hasEffectRevision: 0,
          schemaVersion: packCollabSchemaVersion(
            (await findHeadSchemaVersion(currentDrizzleDb(db), input.documentId)) ??
              COLLAB_SCHEMA_VERSION,
          ),
        })
        .onConflictDoNothing()
        .returning({ id: documentDrafts.id });
      const documentDraft = await activeDocumentDraft(input.documentId, input.branchId);
      if (!documentDraft) {
        throw new Error(
          `Work draft for ${input.documentId} ${inserted ? "vanished" : "was not inserted"}`,
        );
      }
      return documentDraft;
    });
  }

  /**
   * §12.5, O-11: a contribution is any journal row of the draft that
   * isn't discarded (pending, pushed, or awaiting a rollback); then the create stands.
   */
  async function retractCreatedDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
  }): Promise<"stands" | "retracted"> {
    const tx = currentDrizzleDb(db);
    const selection = { documentIds: [input.documentId], branchId: input.branchId };
    await testHook("retract.beforeLocks");
    const drafts = await lockActiveDrafts(tx, selection);
    for (const documentDraft of drafts) {
      const [contribution] = await tx
        .select({ id: draftWriteJournal.id })
        .from(draftWriteJournal)
        .where(
          and(
            eq(draftWriteJournal.draftId, documentDraft.id),
            sql`${draftWriteJournal.status} <> 'discarded'`,
          ),
        )
        .limit(1);
      if (contribution) return "stands";
    }
    await testHook("retract.afterRecheck");
    await deps.close.closeDrafts(tx, selection, "document_discarded");
    return "retracted";
  }

  /** §6.2 step 5: seeded from the document's durable live state, read in this transaction. */
  async function ensureCreatedDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
  }): Promise<void> {
    if (!live) throw new Error("A created document's draft needs the collab live journal");
    const snapshot = await live.journal.read(input.documentId);
    const liveDoc = createCollabYDoc({ gc: false });
    try {
      if (snapshot.checkpoint) Y.applyUpdate(liveDoc, snapshot.checkpoint);
      for (const update of snapshot.updates) Y.applyUpdate(liveDoc, update.update);
      await ensureDocumentDraft({ ...input, liveDoc });
    } finally {
      liveDoc.destroy();
    }
  }

  /**
   * Callers route scratch and uploads live (D9), and pick a branch that may hold the
   * document (`branchMayHold`); reaching here otherwise is a routing or authorization bug.
   * Every document draft is created here, so no entry point can pair a document with a
   * branch that may not hold it.
   */
  async function assertDraftableInBranch(
    documentId: DocumentId,
    branchId: BranchId,
  ): Promise<void> {
    const tx = currentDrizzleDb(db);
    const owner = await loadDocumentOwner(tx, documentId);
    if (owner && isContextUriScheme(owner.scheme) && !isDrafted(owner.scheme)) {
      throw new Error(`Document ${documentId} is in ${owner.scheme}://, which is never drafted`);
    }
    const holder = await loadBranchHolder(tx, branchId);
    if (!owner || !holder || !branchMayHold(holder, owner)) {
      throw new Error(`Branch ${branchId} may not hold document ${documentId}`);
    }
  }

  /**
   * The thread's peer in the given branch (contract §2.5): never ensures a branch. The branch
   * is held `FOR SHARE` while the peer is made, so a close either waits for this to commit or
   * has already closed it (then the peer is stale). Only creating the branch's draft locks
   * the Work. Returns the peer's content as it stands.
   */
  async function ensureThreadPeerDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    branchId: BranchId;
    liveDoc: Y.Doc;
  }): Promise<{ documentDraft: DraftSnapshot; state: Uint8Array }> {
    type EnsuredPeer = { documentDraft: DraftSnapshot; state: Uint8Array };
    const currentPeer = async (): Promise<EnsuredPeer | null> => {
      const existing = await findActiveThreadPeer(input.documentId, input.threadId);
      if (existing?.branchId !== input.branchId) return null;
      if (!(await branches.shareActive(input.branchId))) {
        throw new DraftStaleUpdateError(`Branch ${input.branchId}`);
      }
      return { documentDraft: existing, state: await encodedDraft(existing.draftId) };
    };
    const createPeer = async (): Promise<EnsuredPeer> => {
      if (!(await branches.shareActive(input.branchId))) {
        throw new DraftStaleUpdateError(`Branch ${input.branchId}`);
      }
      await lockDocumentMutation(currentDrizzleDb(db), input.documentId);
      await requireLivingDocument(currentDrizzleDb(db), input.documentId);
      await testHook("draft.peer.afterDocumentLock");
      const existing = await findActiveThreadPeer(input.documentId, input.threadId);
      if (existing?.branchId === input.branchId) {
        return { documentDraft: existing, state: await encodedDraft(existing.draftId) };
      }
      const workDraft = await activeDocumentDraft(input.documentId, input.branchId);
      if (!workDraft) throw new DraftStaleUpdateError(`Branch ${input.branchId}`);
      const upstream = await readDraftAt(currentDrizzleDb(db), workDraft.draftId);
      if (upstream?.documentDraft.status !== "active")
        throw new DraftStaleUpdateError(workDraft.draftId);
      const upstreamDoc = materializeDraftRead(upstream);
      let seed: { state: Buffer; stateVector: Buffer };
      try {
        seed = replicatedSnapshotFrom(upstreamDoc);
      } finally {
        upstreamDoc.destroy();
      }
      if (existing)
        await deps.close.closeDrafts(
          currentDrizzleDb(db),
          { draftIds: [existing.draftId] },
          "edit_discarded",
        );
      const [row] = await currentDrizzleDb(db)
        .insert(documentDrafts)
        .values({
          id: `draft_${randomUUID()}`,
          documentId: input.documentId,
          kind: "thread_peer",
          upstreamDraftId: workDraft.draftId,
          branchId: input.branchId,
          threadId: input.threadId,
          status: "active",
          ...seed,
          hasEffect: false,
          schemaVersion: packCollabSchemaVersion(workDraft.schemaVersion),
        })
        .returning({ id: documentDrafts.id });
      if (!row) throw new Error("Failed to create document draft");
      const documentDraft = await getDraftSnapshot(row.id);
      return { documentDraft, state: seed.state };
    };
    // Each step is one root transaction under the thread lock. Alone, the root takes the
    // thread lock itself: one connection, never a lock-holding connection waiting for a
    // second one from a drained pool. Inside a caller's transaction, that transaction holds
    // the thread lock (keeping authority stable) and the draft writes commit independently;
    // reacquiring the thread row in the root would self-deadlock.
    const underThread = <T>(step: () => Promise<T>): Promise<T> =>
      isInDrizzleTransaction()
        ? runInDrizzleTransaction(db, async () => {
            await lockThreadForMutation(db, input.threadId);
            return runInRootDrizzleTransaction(db, step);
          })
        : runInRootDrizzleTransaction(db, async () => {
            await lockThreadForMutation(db, input.threadId);
            return step();
          });
    const current = await underThread(currentPeer);
    if (current) return current;
    // The Work draft first, in its own Work-first transaction when it creates one (decision
    // D12), so no step holds the branch row or a draft row before the Work; the peer follows.
    await runInRootDrizzleTransaction(db, () =>
      ensureDocumentDraft({
        documentId: input.documentId,
        branchId: input.branchId,
        liveDoc: input.liveDoc,
      }),
    );
    return underThread(createPeer);
  }

  async function encodedDraft(draftId: string): Promise<Uint8Array> {
    const read = await readDraftAt(currentDrizzleDb(db), draftId);
    if (!read) throw new Error(`Draft ${draftId} does not exist`);
    if (!read.tail.length && read.checkpoint) return read.checkpoint.state;
    const doc = materializeDraftRead(read);
    try {
      return Y.encodeStateAsUpdate(doc);
    } finally {
      doc.destroy();
    }
  }

  async function findActiveThreadPeer(
    documentId: DocumentId,
    threadId: ThreadId,
  ): Promise<DraftSnapshot | null> {
    const [row] = await selectDraft(currentDrizzleDb(db))
      .where(
        and(
          eq(documentDrafts.documentId, documentId),
          eq(documentDrafts.threadId, threadId),
          eq(documentDrafts.kind, "thread_peer"),
          eq(documentDrafts.status, "active"),
        ),
      )
      .limit(1);
    return row ? mapDraft(row) : null;
  }

  async function closeThreadPeersOf(
    upstreamDraftIds: readonly string[],
    cause: Exclude<DraftCloseCause, object>,
  ): Promise<void> {
    if (upstreamDraftIds.length === 0) return;
    await deps.close.closeDrafts(currentDrizzleDb(db), { upstreamDraftIds }, cause);
  }

  async function getDraftSnapshot(draftId: string): Promise<DraftSnapshot> {
    const [row] = await selectDraft(currentDrizzleDb(db))
      .where(eq(documentDrafts.id, draftId))
      .limit(1);
    if (!row) throw new Error(`Draft ${draftId} does not exist`);
    return mapDraft(row);
  }

  /**
   * Shape A in its own savepoint (design §2.6): inside an ambient transaction a contained,
   * prefix-missing or refused outcome rolls back the bump and everything registered inside it,
   * the caller's earlier writes untouched; the outcome is mapped only after that unwound. Takes
   * only the draft row: no Work lock, no count, no effect.
   */
  async function appendRows(input: AppendRowsInput): Promise<AppendRowsOutcome> {
    const startedAt = performance.now();
    try {
      return await runInDrizzleSavepoint(db, async () => {
        const tx = currentDrizzleDb(db);
        let finalized:
          | { rows: readonly AppendDraftJournalInput[]; receipts: readonly AppendReceiptGroup[] }
          | undefined;
        let prefix = { rows: 0, moved: false };
        const committed = await appendRowsWithinTx(tx, {
          draftId: input.draftId,
          base: input.base,
          async finalize(read) {
            prefix = { rows: read.tail.length, moved: read.checkpoint !== null };
            const outcome = await input.finalize(read);
            if (outcome.status === "appended") finalized = outcome;
            return outcome;
          },
        });
        if (!finalized) throw new Error(`Draft ${input.draftId} append was not finalized`);
        await recordAppendReceipts(tx, input, finalized, committed.rowIds);
        await testHook("draft.append.beforeCommit");
        if (onAppendSequenced) {
          const { lockedAt, rowIds } = committed;
          deferUntilDrizzleCommit(() =>
            onAppendSequenced({
              draftId: input.draftId,
              waitMs: Math.round(lockedAt - startedAt),
              holdMs: Math.round(performance.now() - lockedAt),
              rows: rowIds.length,
              prefixRows: prefix.rows,
              prefixMoved: prefix.moved,
            }),
          );
        }
        return {
          status: "appended" as const,
          revision: committed.revision,
          checkpointRevision: committed.checkpointRevision,
          rowIds: committed.rowIds,
        };
      });
    } catch (cause) {
      if (cause instanceof DraftWriteRollback && !isRewriteOutcome(cause.outcome))
        return cause.outcome;
      throw cause;
    }
  }

  /**
   * The projection's write (design §3.2) in a root transaction of its own: `has_effect` and its
   * watermark at exactly `revision`, inside the Work boundary's `mutate` when the draft has a
   * Work (Work first, then touched). `lock_timeout` bounds each lock acquisition (the Work, the
   * draft row an append holds, the Works-notice participants at commit), not the transaction;
   * a miss aborts with `55P03`, mapped here, outside the transaction, to `contended`.
   */
  async function writeEffect(input: {
    draftId: string;
    revision: number;
    hasEffect: boolean;
    workId: WorkId | null;
  }): Promise<"written" | "moved" | "contended"> {
    const write = async () => {
      const [row] = await currentDrizzleDb(db)
        .update(documentDrafts)
        .set({ hasEffect: input.hasEffect, hasEffectRevision: input.revision })
        .where(
          and(eq(documentDrafts.id, input.draftId), eq(documentDrafts.revision, input.revision)),
        )
        .returning({ id: documentDrafts.id });
      // The judgement no longer holds: the Work is not touched for it.
      if (!row) throw new DraftWriteRollback({ status: "moved" });
    };
    const { workId } = input;
    try {
      await runInRootDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db).execute(
          sql.raw(`SET LOCAL lock_timeout = '${EFFECT_WRITE_LOCK_TIMEOUT}'`),
        );
        await (workId ? workProjection.mutate({ works: [workId] }, write) : write());
      });
      return "written";
    } catch (cause) {
      if (cause instanceof DraftWriteRollback) return "moved";
      if (sqlState(cause) === "55P03") return "contended";
      throw cause;
    }
  }

  /**
   * One keyset page of the stale set: active work drafts whose watermark is behind their
   * revision, newest first with `id` as the tie-breaker, after `after` when given.
   */
  async function staleEffectDrafts(input: { after?: StaleEffectCursor; limit: number }) {
    const { after } = input;
    const position = sql`(${documentDrafts.updatedAt}, ${documentDrafts.id})`;
    return currentDrizzleDb(db)
      .select({
        draftId: documentDrafts.id,
        updatedAt: sql<string>`${documentDrafts.updatedAt}::text`,
      })
      .from(documentDrafts)
      .where(
        and(
          eq(documentDrafts.kind, "work_draft"),
          eq(documentDrafts.status, "active"),
          lt(documentDrafts.hasEffectRevision, documentDrafts.revision),
          after
            ? sql`${position} < (${after.updatedAt}::timestamptz, ${after.draftId})`
            : undefined,
        ),
      )
      .orderBy(desc(documentDrafts.updatedAt), desc(documentDrafts.id))
      .limit(input.limit);
  }

  /**
   * Shape B: one transaction, the draft row locked only for the fold and its write. A
   * checkpoint (a thread peer's catch-up) carries the Work-is-active predicate; a pull,
   * compaction carries none, so an archived Work's drafts keep rebasing on live.
   */
  async function commitRewrite(input: CommitRewriteInput): Promise<RewriteOutcome> {
    const { operation } = input;
    const rewrite = async (): Promise<RewriteOutcome> => {
      const tx = currentDrizzleDb(db);
      const outcome = await commitRewriteWithinTx(tx, {
        draftId: input.draftId,
        policy: input.policy,
        work: operation.kind === "checkpoint" ? "active" : "any",
        keepUpdatedAt: operation.kind === "compact",
        // Only a pull moves a work draft's content against its baseline, and its caller
        // computed the effect on the candidate; a peer has none, a compaction keeps the
        // content and a reset is effect-free by construction.
        ...(operation.kind === "pull" && operation.effect ? { effect: operation.effect } : {}),
        ...(input.upstream ? { upstream: input.upstream } : {}),
        doc: input.doc,
        ...(onRewriteCommitted
          ? {
              onLocked: ({ lockedAt, tailRows }) => {
                deferUntilDrizzleCommit(() =>
                  onRewriteCommitted({
                    draftId: input.draftId,
                    rewrite: operation.kind,
                    holdMs: Math.round(performance.now() - lockedAt),
                    tailRows,
                  }),
                );
              },
            }
          : {}),
      });
      if (outcome.status !== "committed") throw new DraftWriteRollback(outcome);
      await testHook("draft.rewrite.beforeCommit");
      return {
        status: "committed",
        revision: outcome.revision,
        checkpointRevision: outcome.checkpointRevision,
        seq: outcome.seq,
      };
    };
    const run =
      operation.kind === "pull"
        ? () =>
            runInDrizzleTransaction(db, () =>
              workProjection.mutate({ drafts: [input.draftId] }, rewrite),
            )
        : () => runInDrizzleTransaction(db, rewrite);
    return run().catch((cause): RewriteOutcome => {
      if (cause instanceof DraftWriteRollback && isRewriteOutcome(cause.outcome))
        return cause.outcome;
      throw cause;
    });
  }

  return {
    deferUntilCommit(callback, onRollback) {
      if (!deferUntilDrizzleCommit(callback)) return false;
      if (onRollback) deferUntilDrizzleRollback(onRollback);
      return true;
    },

    async getDraft(draftId) {
      const [row] = await selectDraft(currentDrizzleDb(db))
        .where(eq(documentDrafts.id, draftId))
        .limit(1);
      return row ? mapDraft(row) : null;
    },

    readDraftAt(draftId, since) {
      return readDraftAt(currentDrizzleDb(db), draftId, since);
    },

    readEffectBaseline(draftId) {
      return readEffectBaselineWithin(currentDrizzleDb(db), draftId);
    },

    appendRows,
    writeEffect,
    staleEffectDrafts,
    commitRewrite,

    async resolveThreadDraft(documentId, threadId): Promise<ResolvedDraft> {
      const workId = await findPrimaryWork(threadId).catch((cause) => {
        if (cause instanceof NoPrimaryWorkError) throw new DraftNotFoundError(documentId, threadId);
        throw cause;
      });
      const row = await findActiveThreadPeer(documentId, threadId);
      if (!row || row.workId !== workId) throw new DraftNotFoundError(documentId, threadId);
      return resolved(row);
    },

    async resolveWorkDraftForThread(documentId, threadId): Promise<ResolvedDraft> {
      let workId: WorkId;
      try {
        workId = await findPrimaryWork(threadId);
      } catch (cause) {
        if (cause instanceof NoPrimaryWorkError) throw new DraftNotFoundError(documentId, threadId);
        throw cause;
      }
      const branch = await branches.activeForWork(workId);
      const row = branch ? await activeDocumentDraft(documentId, branch.id) : null;
      if (!row) throw new DraftNotFoundError(documentId, threadId);
      return resolved(row);
    },

    async listActiveWorkDraftIds(documentId) {
      const rows = await currentDrizzleDb(db)
        .select({ id: documentDrafts.id })
        .from(documentDrafts)
        .where(
          and(
            eq(documentDrafts.documentId, documentId),
            eq(documentDrafts.kind, "work_draft"),
            eq(documentDrafts.status, "active"),
          ),
        );
      return rows.map((row) => row.id);
    },

    ensureDocumentDraft(input) {
      return runInDrizzleTransaction(db, () => ensureDocumentDraft(input));
    },

    ensureCreatedDocumentDraft,
    retractCreatedDocumentDraft,
    closeThreadPeersOf,

    ensureThreadPeerDraft(input) {
      return ensureThreadPeerDraft(input);
    },
  };
}

function resolved({ draftId, status, lifecycle }: DraftSnapshot): ResolvedDraft {
  return { draftId, status, lifecycle };
}

class NoPrimaryWorkError extends Error {
  constructor(readonly threadId: ThreadId) {
    super(`Thread ${threadId} is not linked to a primary work`);
    this.name = "NoPrimaryWorkError";
  }
}

function isRewriteOutcome(outcome: DraftWriteRollback["outcome"]): outcome is RewriteOutcome {
  return !["contained", "prefixMissing", "refused"].includes(outcome.status);
}

/** The PostgreSQL SQLSTATE of `cause` or of an error it wraps (Drizzle wraps in `cause`). */
function sqlState(cause: unknown): string | null {
  let current: unknown = cause;
  while (current) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The receipts finalization captured, written with the row ids the append allocated. */
async function recordAppendReceipts(
  db: Pick<Database, "select" | "insert" | "update">,
  input: Pick<AppendRowsInput, "draftId" | "documentId">,
  finalized: { rows: readonly AppendDraftJournalInput[]; receipts: readonly AppendReceiptGroup[] },
  rowIds: readonly number[],
): Promise<void> {
  for (const group of finalized.receipts) {
    const journal = finalized.rows[group.rowIndexes[0]];
    if (!journal) throw new Error("A receipt group names no appended row");
    const meta =
      journal.updateMeta && typeof journal.updateMeta === "object"
        ? (journal.updateMeta as Record<string, unknown>)
        : {};
    await recordDocumentEdit(db, {
      documentId: input.documentId,
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
      receipts: group.parts.map((part, i) => ({
        ...part,
        origin: {
          kind: "pending" as const,
          draftId: input.draftId,
          rowId: rowIds[group.rowIndexes[i]],
        },
      })),
    });
  }
}
