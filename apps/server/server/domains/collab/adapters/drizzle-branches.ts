/**
 * The application branch store over Drizzle: branch creation and resolution, and the
 * application half of each write (Work admission, the pending projection, the live advisory
 * lock, the effect refresh and edit receipts) around the storage primitives in
 * `drizzle-branch-storage`.
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
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as Y from "yjs";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  isInDrizzleTransaction,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { lockThreadForMutation } from "../../../shared/thread-work-lock.js";
import { draftBranchWorks } from "../../../shared/work-draft-lifecycle.js";
import { lockWorksInIdOrder } from "../../../shared/work-lifecycle-lock.js";
import {
  draftMayHold,
  loadDocumentOwner,
  loadDraftHolder,
} from "../../context/tree/draft-ownership.js";
import { isDrafted } from "../../file-policy/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { BranchNotFoundError, type ResolvedBranch } from "../domain/branch-resolver.js";
import {
  type AppendRowsInput,
  type AppendRowsOutcome,
  type BranchSnapshot,
  BranchStaleUpdateError,
  type CommitRewriteInput,
  materializeBranchRead,
  type RewriteOutcome,
} from "../domain/branch-store.js";
import { collabHook } from "../domain/collab-test-hooks.js";
import { replicateFrozenIdentity } from "../domain/document-mutation-policy.js";
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
import { refreshDraftEffect } from "./drizzle-draft-effect.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

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
   * commit or has already closed it (then the peer is stale). Locks no Work row. Returns the
   * peer's content as it stands.
   */
  async function ensureThreadPeerBranch(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: DraftId;
    liveDoc: Y.Doc;
  }): Promise<{ branch: BranchSnapshot; state: Uint8Array }> {
    const ensurePeer = async (): Promise<{ branch: BranchSnapshot; state: Uint8Array }> => {
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
      const upstream = await readBranchAt(currentDrizzleDb(db), workDraft.branchId);
      if (!upstream) throw new Error(`Branch ${workDraft.branchId} does not exist`);
      const upstreamDoc = materializeBranchRead(upstream);
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

  /**
   * Shape A: rows appended past the checkpoint under `revision = expectedRevision`, with the
   * effect and receipts the caller computed on its candidate. A common append takes only its
   * branch row: the derived lifecycle predicate fences the Work, and every membership input
   * moves the revision. An append that flips the branch's review membership locks its Work
   * first and touches the Work's projection; no count query runs.
   */
  async function appendRows(input: AppendRowsInput): Promise<AppendRowsOutcome> {
    const nested = isInDrizzleTransaction();
    const outcome = await runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db);
      if (input.workTouch) await lockWorksInIdOrder(tx, [input.workTouch]);
      const { revision, rowIds } = await appendRowsWithinTx(tx, input);
      await recordAppendReceipts(tx, input, rowIds);
      if (input.workTouch) await workProjection?.touchWorks([input.workTouch]);
      return { status: "appended" as const, revision, rowIds };
    }).catch((cause) => {
      if (cause instanceof BranchWriteRollback) return { status: "moved" as const };
      throw cause;
    });
    if (!nested && outcome.status === "appended") await collabHook("branch.append.afterCommit");
    return outcome;
  }

  /** The Work row, then the branch row, held for one frame's last judgement. */
  async function withJudgementLocks<T>(branchId: string, run: () => Promise<T>): Promise<T> {
    return runInDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db);
      const [owner] = await draftBranchWorks(tx, [branchId]);
      if (owner?.workId) await lockWorksInIdOrder(tx, [owner.workId]);
      await tx
        .select({ id: documentBranches.id })
        .from(documentBranches)
        .where(eq(documentBranches.id, branchId))
        .for("update");
      return run();
    });
  }

  /**
   * Shape B: one transaction, the branch row locked only for the fold and its write. A
   * checkpoint (a thread peer's catch-up) carries the Work-is-active predicate; a pull,
   * reset or compaction carries none.
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
        ...(input.upstream ? { upstream: input.upstream } : {}),
        doc: input.doc,
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
      let revision = outcome.revision;
      // Only a pull moves a work draft's content against its baseline; a peer has no effect,
      // a compaction keeps the content and a reset is effect-free by construction.
      if (operation.kind === "pull") {
        const effect = await refreshDraftEffect(tx, input.branchId, operation.liveCut);
        if (effect) revision = effect.revision;
      }
      await collabHook("branch.rewrite.beforeCommit");
      return {
        status: "committed",
        revision,
        checkpointRevision: outcome.checkpointRevision,
        seq: outcome.seq,
        generation: outcome.generation,
      };
    };
    const run =
      operation.kind === "pull" || operation.kind === "reset"
        ? () => runInDrizzleTransaction(db, () => mutatePending([input.branchId], rewrite))
        : () => runInDrizzleTransaction(db, rewrite);
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

    readEffectBaseline(branchId) {
      return readEffectBaselineWithin(currentDrizzleDb(db), branchId, async (documentId) => {
        const snapshot = await createDrizzleJournal(db).read(documentId);
        const live = createCollabYDoc({ gc: false });
        try {
          if (snapshot.checkpoint) Y.applyUpdate(live, snapshot.checkpoint);
          for (const row of snapshot.updates) Y.applyUpdate(live, row.update);
          return Y.encodeStateAsUpdate(live);
        } finally {
          live.destroy();
        }
      });
    },

    appendRows,
    withJudgementLocks,
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

function resolved({ branchId, generation, status, lifecycle }: BranchSnapshot): ResolvedBranch {
  return { branchId, generation, status, lifecycle };
}

class NoPrimaryWorkError extends Error {
  constructor(readonly threadId: ThreadId) {
    super(`Thread ${threadId} is not linked to a primary work`);
    this.name = "NoPrimaryWorkError";
  }
}

/** The receipts an append's caller computed, written with the row ids the append allocated. */
async function recordAppendReceipts(
  db: Pick<Database, "select" | "insert" | "update">,
  input: AppendRowsInput,
  rowIds: readonly number[],
): Promise<void> {
  for (const group of input.receipts) {
    const journal = input.rows[group.rowIndexes[0]];
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
