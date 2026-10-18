/**
 * The application branch store over Drizzle: branch creation and resolution, and the
 * application half of each write (Work admission, the pending projection, the projection's
 * effect write and edit receipts) around the storage primitives in `drizzle-branch-storage`.
 */

import { randomUUID } from "node:crypto";
import type { DocumentLifecycle, UpdateJournal } from "@meridian/agent-edit/integration";
import type { DraftId } from "@meridian/contracts";
import { isContextUriScheme } from "@meridian/contracts/context-uri";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branchWriteJournal,
  documentBranches,
  documentYjsHeads,
  threadWorks,
} from "@meridian/database/schema";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  createCollabYDoc,
  packCollabSchemaVersion,
  unpackCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import * as Y from "yjs";
import { bumpBranchRevisions } from "../../../shared/branch-revisions.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  deferUntilDrizzleRollback,
  isInDrizzleTransaction,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { lockThreadForMutation } from "../../../shared/thread-work-lock.js";
import {
  draftMayHold,
  loadDocumentOwner,
  loadDraftHolder,
} from "../../context/tree/draft-ownership.js";
import { isDrafted } from "../../file-policy/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { BranchNotFoundError, type ResolvedBranch } from "../domain/branch-resolver.js";
import {
  type AppendBranchJournalInput,
  type AppendReceiptGroup,
  type AppendRowsInput,
  type AppendRowsOutcome,
  type BranchSnapshot,
  BranchStaleUpdateError,
  type CommitRewriteInput,
  materializeBranchRead,
  type RewriteOutcome,
  type StaleEffectCursor,
} from "../domain/branch-store.js";
import { collabHook } from "../domain/collab-test-hooks.js";
import { replicateFrozenSource } from "../domain/document-mutation-policy.js";
import type { Drafts } from "../domain/drafts.js";
import type { PeerRetirementCause, RetiredBranch } from "../domain/peer-retirement.js";
import type { ApplicationBranchStore } from "../domain/ports/application-branch-store.js";
import {
  appendRowsWithinTx,
  BranchWriteRollback,
  commitRewriteWithinTx,
  mapBranch,
  readBranchAt,
  readEffectBaselineWithin,
  selectBranch,
} from "./drizzle-branch-storage.js";
import { recordDocumentEdit, settleDraftGeneration } from "./drizzle-document-edits.js";

export type RewriteCommitted = {
  branchId: string;
  rewrite: CommitRewriteInput["operation"]["kind"];
  holdMs: number;
  tailRows: number;
};

/**
 * An append committed: how long its `UPDATE` waited for the branch row (`waitMs`), how long it
 * then held the row to `COMMIT` (`holdMs`), the rows it wrote and the rows that landed between
 * its base and its lock.
 */
export type AppendCommitted = {
  branchId: string;
  waitMs: number;
  holdMs: number;
  rows: number;
  prefixRows: number;
  prefixMoved: boolean;
};

/** The projection write's bound on each lock acquisition, not on the transaction (G5, C1). */
const EFFECT_WRITE_LOCK_TIMEOUT = "100ms";

export function createDrizzleBranchStore(
  db: Database,
  deps: {
    live?: {
      journal: UpdateJournal;
      lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
    };
    /** The one owner of Work-first order and the Works' projection (decision D17). */
    workProjection: WorkProjectionMutation;
    /** A peer ensure relies on its draft staying active; a thread finds its Work's draft. */
    drafts: Pick<Drafts, "shareActive" | "activeForWork">;
    /** A `commitRewrite` committed: the row lock's hold (`FOR UPDATE` → `COMMIT`) and its tail. */
    onRewriteCommitted?: (detail: RewriteCommitted) => void;
    /** An `appendRows` committed: its wait for the row lock and its hold to `COMMIT`. */
    onAppendSequenced?: (detail: AppendCommitted) => void;
  },
): ApplicationBranchStore {
  const { live, workProjection, drafts, onRewriteCommitted, onAppendSequenced } = deps;
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
    const seed = replicatedSnapshotFrom(input.liveDoc);
    // Creating a branch is a write the Work's lifecycle orders (decision D12): the draft's
    // Work is locked first, so an Archive either fences the new branch or committed before it.
    // A fresh fork has no effect against its seed, its baseline (`live_cut`), and the judgement
    // is fresh at revision 0: the baseline is frozen here and replaced only under a bump.
    return workProjection.mutate({ drafts: [input.draftId] }, async () => {
      // The insert's own transaction holds D active (§2.1): a closed draft gains no branch.
      if (!(await drafts.shareActive(input.draftId))) {
        throw new BranchStaleUpdateError(`draft:${input.draftId}`);
      }
      await assertDraftableInDraft(input.documentId, input.draftId);
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
          liveCut: seed.state,
          hasEffect: false,
          hasEffectRevision: 0,
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
    });
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
    await collabHook("retract.beforeLocks");
    // A frame takes no lock but its branch row: holding the rows (id order, after the
    // caller's Work and namespace order) makes a contribution that committed first visible
    // to the recheck below, and makes one that comes later find its row deleted.
    if (branches.length > 0)
      await tx
        .select({ id: documentBranches.id })
        .from(documentBranches)
        .where(
          inArray(
            documentBranches.id,
            branches.map((branch) => branch.id),
          ),
        )
        .orderBy(asc(documentBranches.id))
        .for("update");
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
    await collabHook("retract.afterRecheck");
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
   * is held `FOR SHARE` while the peer is made, so a close either waits for this to commit or
   * has already closed it (then the peer is stale). Only creating the draft's branch locks
   * the Work. Returns the peer's content as it stands.
   */
  async function ensureThreadPeerBranch(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: DraftId;
    liveDoc: Y.Doc;
  }): Promise<{ branch: BranchSnapshot; state: Uint8Array }> {
    type EnsuredPeer = { branch: BranchSnapshot; state: Uint8Array };
    const currentPeer = async (): Promise<EnsuredPeer | null> => {
      const existing = await findActiveThreadPeer(input.documentId, input.threadId);
      if (existing?.draftId !== input.draftId) return null;
      if (!(await drafts.shareActive(input.draftId))) {
        throw new BranchStaleUpdateError(`draft:${input.draftId}`);
      }
      return { branch: existing, state: await encodedBranch(existing.branchId) };
    };
    const createPeer = async (): Promise<EnsuredPeer> => {
      if (!(await drafts.shareActive(input.draftId))) {
        throw new BranchStaleUpdateError(`draft:${input.draftId}`);
      }
      const existing = await findActiveThreadPeer(input.documentId, input.threadId);
      if (existing?.draftId === input.draftId) {
        return { branch: existing, state: await encodedBranch(existing.branchId) };
      }
      const workDraft = await activeDraftBranch(input.documentId, input.draftId);
      if (!workDraft) throw new BranchStaleUpdateError(`draft:${input.draftId}`);
      const upstream = await readBranchAt(currentDrizzleDb(db), workDraft.branchId);
      if (!upstream) throw new Error(`Branch ${workDraft.branchId} does not exist`);
      const upstreamDoc = materializeBranchRead(upstream);
      let seed: { state: Buffer; stateVector: Buffer };
      try {
        seed = replicatedSnapshotFrom(upstreamDoc);
      } finally {
        upstreamDoc.destroy();
      }
      if (existing)
        await bumpBranchRevisions(currentDrizzleDb(db), [existing.branchId], { status: "closed" });
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
          schemaVersion: packCollabSchemaVersion(workDraft.schemaVersion),
        })
        .returning({ id: documentBranches.id });
      if (!row) throw new Error("Failed to create document branch");
      const branch = await getBranchSnapshot(row.id);
      return { branch, state: seed.state };
    };
    // Each step is one root transaction under the thread lock. Alone, the root takes the
    // thread lock itself: one connection, never a lock-holding connection waiting for a
    // second one from a drained pool. Inside a caller's transaction, that transaction holds
    // the thread lock (keeping authority stable) and the branch writes commit independently;
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
    // D12), so no step holds the draft row or a branch row before the Work; the peer follows.
    await runInRootDrizzleTransaction(db, () =>
      ensureDraftBranch({
        documentId: input.documentId,
        draftId: input.draftId,
        liveDoc: input.liveDoc,
      }),
    );
    return underThread(createPeer);
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
    const tx = currentDrizzleDb(db);
    const peers = await tx
      .select({ id: documentBranches.id })
      .from(documentBranches)
      .where(
        and(
          inArray(documentBranches.upstreamBranchId, [...upstreamBranchIds]),
          eq(documentBranches.kind, "thread_peer"),
          eq(documentBranches.status, "active"),
        ),
      );
    const closed = await bumpBranchRevisions(
      tx,
      peers.map((row) => row.id),
      { status: "closed" },
    );
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
   * Shape A in its own savepoint (design §2.6): inside an ambient transaction a contained,
   * prefix-missing or refused outcome rolls back the bump and everything registered inside it,
   * the caller's earlier writes untouched; the outcome is mapped only after that unwound. Takes
   * only the branch row: no Work lock, no count, no effect.
   */
  async function appendRows(input: AppendRowsInput): Promise<AppendRowsOutcome> {
    const startedAt = performance.now();
    try {
      return await runInDrizzleSavepoint(db, async () => {
        const tx = currentDrizzleDb(db);
        let finalized:
          | { rows: readonly AppendBranchJournalInput[]; receipts: readonly AppendReceiptGroup[] }
          | undefined;
        let prefix = { rows: 0, moved: false };
        const committed = await appendRowsWithinTx(tx, {
          branchId: input.branchId,
          expectedGeneration: input.expectedGeneration,
          base: input.base,
          async finalize(read) {
            prefix = { rows: read.tail.length, moved: read.checkpoint !== null };
            const outcome = await input.finalize(read);
            if (outcome.status === "appended") finalized = outcome;
            return outcome;
          },
        });
        if (!finalized) throw new Error(`Branch ${input.branchId} append was not finalized`);
        await recordAppendReceipts(tx, input, finalized, committed.rowIds);
        await collabHook("branch.append.beforeCommit");
        if (onAppendSequenced) {
          const { lockedAt, rowIds } = committed;
          deferUntilDrizzleCommit(() =>
            onAppendSequenced({
              branchId: input.branchId,
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
      if (cause instanceof BranchWriteRollback && !isRewriteOutcome(cause.outcome))
        return cause.outcome;
      throw cause;
    }
  }

  /**
   * The projection's write (design §3.2) in a root transaction of its own: `has_effect` and its
   * watermark at exactly `revision`, inside the Work boundary's `mutate` when the branch has a
   * Work (Work first, then touched). `lock_timeout` bounds each lock acquisition (the Work, the
   * branch row an append holds, the publication participants at commit), not the transaction;
   * a miss aborts with `55P03`, mapped here, outside the transaction, to `contended`.
   */
  async function writeEffect(input: {
    branchId: string;
    revision: number;
    hasEffect: boolean;
    workId: WorkId | null;
  }): Promise<"written" | "moved" | "contended"> {
    const write = async () => {
      const [row] = await currentDrizzleDb(db)
        .update(documentBranches)
        .set({ hasEffect: input.hasEffect, hasEffectRevision: input.revision })
        .where(
          and(
            eq(documentBranches.id, input.branchId),
            eq(documentBranches.revision, input.revision),
          ),
        )
        .returning({ id: documentBranches.id });
      // The judgement no longer holds: the Work is not touched for it.
      if (!row) throw new BranchWriteRollback({ status: "moved" });
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
      if (cause instanceof BranchWriteRollback) return "moved";
      if (sqlState(cause) === "55P03") return "contended";
      throw cause;
    }
  }

  /**
   * One keyset page of the stale set: active work drafts whose watermark is behind their
   * revision, newest first with `id` as the tie-breaker, after `after` when given.
   */
  async function staleEffectBranches(input: { after?: StaleEffectCursor; limit: number }) {
    const { after } = input;
    const position = sql`(${documentBranches.updatedAt}, ${documentBranches.id})`;
    return currentDrizzleDb(db)
      .select({
        branchId: documentBranches.id,
        updatedAt: sql<string>`${documentBranches.updatedAt}::text`,
      })
      .from(documentBranches)
      .where(
        and(
          eq(documentBranches.kind, "work_draft"),
          eq(documentBranches.status, "active"),
          lt(documentBranches.hasEffectRevision, documentBranches.revision),
          after
            ? sql`${position} < (${after.updatedAt}::timestamptz, ${after.branchId})`
            : undefined,
        ),
      )
      .orderBy(desc(documentBranches.updatedAt), desc(documentBranches.id))
      .limit(input.limit);
  }

  /**
   * Shape B: one transaction, the branch row locked only for the fold and its write. A
   * checkpoint (a thread peer's catch-up) carries the Work-is-active predicate; a pull,
   * reset or compaction carries none, so an archived Work's drafts keep rebasing on live.
   */
  async function commitRewrite(input: CommitRewriteInput): Promise<RewriteOutcome> {
    const { operation } = input;
    const rewrite = async (): Promise<RewriteOutcome> => {
      const tx = currentDrizzleDb(db);
      const outcome = await commitRewriteWithinTx(tx, {
        branchId: input.branchId,
        policy: input.policy,
        fence: input.fence,
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
                    branchId: input.branchId,
                    rewrite: operation.kind,
                    holdMs: Math.round(performance.now() - lockedAt),
                    tailRows,
                  }),
                );
              },
            }
          : {}),
        ...(operation.kind === "reset"
          ? {
              reset: { kind: "discard" as const },
              schemaVersion: operation.schemaVersion,
            }
          : {}),
      });
      if (outcome.status !== "committed") throw new BranchWriteRollback(outcome);
      if (operation.kind === "reset")
        await settleDraftGeneration(
          tx,
          input.branchId,
          outcome.generation - 1,
          operation.editDisposition,
        );
      await collabHook("branch.rewrite.beforeCommit");
      return {
        status: "committed",
        revision: outcome.revision,
        checkpointRevision: outcome.checkpointRevision,
        seq: outcome.seq,
        generation: outcome.generation,
      };
    };
    const run =
      operation.kind === "pull" || operation.kind === "reset"
        ? () =>
            runInDrizzleTransaction(db, () =>
              workProjection.mutate({ branches: [input.branchId] }, rewrite),
            )
        : () => runInDrizzleTransaction(db, rewrite);
    return run().catch((cause): RewriteOutcome => {
      if (cause instanceof BranchWriteRollback && isRewriteOutcome(cause.outcome))
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

    async getBranch(branchId) {
      const [row] = await selectBranch(currentDrizzleDb(db))
        .where(eq(documentBranches.id, branchId))
        .limit(1);
      return row ? mapBranch(row) : null;
    },

    readBranchAt(branchId, since) {
      return readBranchAt(currentDrizzleDb(db), branchId, since);
    },

    readEffectBaseline(branchId) {
      return readEffectBaselineWithin(currentDrizzleDb(db), branchId);
    },

    appendRows,
    writeEffect,
    staleEffectBranches,
    commitRewrite,

    async resolveThreadBranch(documentId, threadId): Promise<ResolvedBranch> {
      const workId = await findPrimaryWork(threadId).catch((cause) => {
        if (cause instanceof NoPrimaryWorkError)
          throw new BranchNotFoundError(documentId, threadId);
        throw cause;
      });
      const row = await findActiveThreadPeer(documentId, threadId);
      if (!row || row.workId !== workId) throw new BranchNotFoundError(documentId, threadId);
      return resolved(row);
    },

    async resolveWorkDraftBranchForThread(documentId, threadId): Promise<ResolvedBranch> {
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
      return resolved(row);
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

function resolved({ branchId, generation, status, lifecycle }: BranchSnapshot): ResolvedBranch {
  return { branchId, generation, status, lifecycle };
}

class NoPrimaryWorkError extends Error {
  constructor(readonly threadId: ThreadId) {
    super(`Thread ${threadId} is not linked to a primary work`);
    this.name = "NoPrimaryWorkError";
  }
}

function isRewriteOutcome(outcome: BranchWriteRollback["outcome"]): outcome is RewriteOutcome {
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
  input: Pick<AppendRowsInput, "branchId" | "documentId" | "expectedGeneration">,
  finalized: { rows: readonly AppendBranchJournalInput[]; receipts: readonly AppendReceiptGroup[] },
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
          branchId: input.branchId,
          generation: input.expectedGeneration,
          rowId: rowIds[group.rowIndexes[i]],
        },
      })),
    });
  }
}
