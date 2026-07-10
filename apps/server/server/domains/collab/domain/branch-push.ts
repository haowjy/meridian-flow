/** Durable-first work-draft to live push service for branch peers. */
import { createHash, randomUUID } from "node:crypto";
import {
  type DocumentCoordinator,
  toDocHandle,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { MarkupCodec } from "@meridian/markup";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import { documentMutationLockKey } from "./document-mutation-lock.js";
import {
  decodeUpdateForDependencies,
  deleteRanges,
  hasDependentLaterRows,
  rangeCovers,
  suppliedRanges,
} from "./journal-dependencies.js";

export type BranchJournalRow = {
  id: number;
  branchId: string;
  generation: number;
  wId: number | null;
  source: "agent" | "writer";
  threadId: ThreadId | null;
  turnId: TurnId | null;
  actorUserId: UserId | null;
  updateData: Uint8Array;
  status: "active" | "pushed" | "discarded" | "rollback_pending";
  updateMeta?: unknown;
};

export type ReceiptBlockChange = {
  blockId: string;
  beforeText: string | null;
  afterText: string | null;
  beforeWordCount: number;
  afterWordCount: number;
  wordDelta: number;
};

export type PushReceiptPayload = {
  version: 1;
  documentId: DocumentId;
  branchId: string;
  branchGeneration: number;
  pushKind: "whole" | "selective";
  changedBlocks: ReceiptBlockChange[];
  totalWordDelta: number;
};

export type PushLineageRow = {
  id: number;
  branchId: string | null;
  documentId: DocumentId;
  pushKind: "whole" | "selective";
  journalIds: number[];
  upstreamUpdateSeq: number | null;
  receiptPayload: PushReceiptPayload | null;
  idempotencyKey: string;
  receiptId?: string | null;
  threadId?: ThreadId | null;
  turnId?: TurnId | null;
};

export type BranchPushConflictEcho = {
  overlappingBlockIds: string[];
  current: Array<
    Pick<BranchJournalRow, "id" | "branchId" | "source" | "threadId" | "turnId" | "wId">
  >;
  concurrentPushes: Array<
    Pick<PushLineageRow, "id" | "branchId" | "threadId" | "turnId" | "journalIds">
  >;
};

export type PushToLiveResult =
  | {
      status: "pushed";
      push: PushLineageRow;
      update: Uint8Array;
      branchReset?: { branchId: string; fromGeneration: number };
      conflictEcho?: BranchPushConflictEcho;
    }
  | { status: "already_pushed"; push: PushLineageRow; conflictEcho?: BranchPushConflictEcho }
  | { status: "push_concurrent_conflict"; conflictedBlocks: string[] }
  | {
      status: "noop";
      branchId: string;
      documentId: DocumentId;
      branchGeneration: number;
      reason: "no_active_rows";
    };

export type PreparedPushCommit = {
  branch: BranchSnapshot;
  journalRows: BranchJournalRow[];
  pushUpdate: Uint8Array;
  receiptPayload: PushReceiptPayload;
  idempotencyKey: string;
  receiptId?: string;
  markdownProjection: string;
  liveStateVector: Uint8Array;
  liveState: Uint8Array;
  pushedByUserId?: UserId;
};

export type PreparedDiscardCommit = {
  branch: BranchSnapshot;
  journalRows: BranchJournalRow[];
  state: Uint8Array;
  stateVector: Uint8Array;
  replacementUpdateData?: Uint8Array;
  replacementUpdateDataByJournalId?: ReadonlyMap<number, Uint8Array>;
  reviewedByUserId?: UserId;
};

export type BranchPushStore = {
  listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  listReviewableJournalRows?(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  listConcurrentJournalRows(
    branchId: string,
    generation: number,
    options: { afterJournalId?: number; documentId: DocumentId },
  ): Promise<BranchJournalRow[]>;
  latestPushForBranch?(branchId: string, generation: number): Promise<PushLineageRow | null>;
  listPushesForDocument?(documentId: DocumentId): Promise<PushLineageRow[]>;
  commitPush(
    input: PreparedPushCommit,
  ): Promise<{ status: "inserted" | "conflict"; push: PushLineageRow }>;
  commitDiscard?(input: PreparedDiscardCommit): Promise<void>;
  commitPushBatch?(input: { pushes: PreparedPushCommit[] }): Promise<{ pushes: PushLineageRow[] }>;
  countUnpushedRowsForWork(workId: WorkId): Promise<number>;
  listActiveWorkDraftBranchIdsForWork(workId: WorkId): Promise<string[]>;
  updateWorkDraftPushPolicy(workId: WorkId, policy: "manual" | "auto"): Promise<void>;
  listJournalRowsForTurn?(input: {
    branchId?: string;
    generation?: number;
    threadId: ThreadId;
    turnId: TurnId;
    statuses?: readonly BranchJournalRow["status"][];
  }): Promise<BranchJournalRow[]>;
  listJournalRowsForBranch?(input: {
    branchId: string;
    generation: number;
    throughJournalId?: number;
  }): Promise<BranchJournalRow[]>;
  listPushLineageForTurn?(input: { threadId: ThreadId; turnId: TurnId }): Promise<PushLineageRow[]>;
  commitTurnRedo?(input: PreparedDiscardCommit): Promise<void>;
  markRollbackPending(input: {
    branchId: string;
    generation: number;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<number>;
};

export type PushUpdateComputer = (input: {
  branch: BranchSnapshot;
  branchDoc: Y.Doc;
  liveDoc: Y.Doc;
}) => Uint8Array;

export type AutoPushAfterThreadPeerWriteInput = {
  workDraftBranchId: string;
  pushedByUserId?: UserId;
};

export type AutoPushAfterThreadPeerWriteResult =
  | PushToLiveResult
  | { status: "skipped"; reason: "manual_policy" | "not_active_work_draft" };

export type BranchPushService = {
  pushToLive(input: { branchId: string; pushedByUserId?: UserId }): Promise<PushToLiveResult>;
  pushSelectedToLive(input: {
    branchId: string;
    journalIds: readonly number[];
    pushedByUserId?: UserId;
  }): Promise<PushToLiveResult>;
  discardSelected(input: {
    branchId: string;
    journalIds: readonly number[];
    reviewedByUserId?: UserId;
  }): Promise<
    | { status: "discarded"; branchId: string; journalIds: number[] }
    | { status: "nothing_to_undo"; branchId: string; journalIds: number[] }
  >;
  reverseBranchTurn(input: {
    branchId: string;
    threadId: ThreadId;
    turnId: TurnId;
    direction: "undo" | "redo";
    reviewedByUserId?: UserId;
  }): Promise<
    | { status: "reversed" | "reconciled"; branchId: string; journalIds: number[] }
    | {
        status: "cant_undo_dependent" | "nothing_to_undo" | "nothing_to_redo";
        branchId: string;
        journalIds: number[];
      }
  >;
  pushToLiveWithManifestEntry(input: {
    branchId: string;
    manifestBranchId: string;
    manifestEntryDocumentId: DocumentId;
    contentJournalIds?: readonly number[];
    pushedByUserId?: UserId;
  }): Promise<PushToLiveResult>;
  pushAutoBranchAfterThreadPeerWrite(
    input: AutoPushAfterThreadPeerWriteInput,
  ): Promise<AutoPushAfterThreadPeerWriteResult>;
  setWorkPushPolicy(input: {
    workId: WorkId;
    policy: "manual" | "auto";
    confirmedPush?: boolean;
    pushedByUserId?: UserId;
  }): Promise<
    | { status: "updated"; policy: "manual" | "auto" }
    | { status: "confirmation_required"; unpushedCount: number; reason: string }
  >;
  markFailedResponseRollbackPending(input: {
    branchId: string;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<
    | { status: "discarded"; branchId: string; journalIds: number[] }
    | { status: "rollback_pending"; rowsMarked: number }
  >;
  getTurnChangeDiff(input: { threadId: ThreadId; turnId: TurnId }): Promise<{
    version: 1;
    source: "pushed" | "branch";
    documents: Array<{
      documentId: DocumentId;
      documentTitle: string;
      blocks: ReceiptBlockChange[];
    }>;
  }>;
};

export function createBranchPushService(input: {
  branchStore: BranchStore;
  pushStore: BranchPushStore;
  branchCoordinator?: Pick<BranchCoordinator, "resetFromDocIfUnchanged"> &
    Partial<Pick<BranchCoordinator, "broadcastUpdate">>;
  journal: UpdateJournal;
  liveCoordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: MarkupCodec;
  pushUpdateComputer?: PushUpdateComputer;
  mutex?: KeyedMutex;
  resolveDocumentTitle?: (documentId: DocumentId) => Promise<string | null>;
}): BranchPushService {
  const mutex = input.mutex ?? new KeyedMutex();
  const computePushUpdate = input.pushUpdateComputer ?? wholeBranchPushUpdate;

  async function loadLiveDoc(documentId: DocumentId): Promise<Y.Doc> {
    const snapshot = await input.journal.read(documentId);
    const doc = createCollabYDoc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    return doc;
  }

  function materializeBranch(branch: BranchSnapshot): Y.Doc {
    const doc = createCollabYDoc({ gc: false });
    Y.applyUpdate(doc, branch.state);
    return doc;
  }

  async function compute(
    branch: BranchSnapshot,
    options: {
      pushKind?: "whole" | "selective";
      selectRows?: (row: BranchJournalRow) => boolean;
    } = {},
  ): Promise<{
    branch: BranchSnapshot;
    rows: BranchJournalRow[];
    pushUpdate: Uint8Array;
    receipt: PushReceiptPayload;
    markdownProjection: string;
    liveStateVector: Uint8Array;
    liveState: Uint8Array;
    idempotencyKey: string;
    receiptId: string;
    conflictEcho?: BranchPushConflictEcho;
  }> {
    const reviewableRows = await listReviewableRows(branch.branchId, branch.generation);
    const rows = options.selectRows ? reviewableRows.filter(options.selectRows) : reviewableRows;
    if (rows.length === 0) {
      const existing = await input.pushStore.latestPushForBranch?.(
        branch.branchId,
        branch.generation,
      );
      if (existing) throw new NoActiveRowsExistingPush(existing);
      throw new NoActiveRowsNoop(branch);
    }
    const pushKind = options.pushKind ?? "whole";
    const liveDoc = await loadLiveDoc(branch.documentId);
    const afterDoc = createCollabYDoc({ gc: false });
    let branchDoc: Y.Doc | null = null;
    try {
      if (pushKind === "selective") {
        Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
        for (const row of rows) Y.applyUpdate(afterDoc, row.updateData);
        assertNoPendingIntegration(
          afterDoc,
          "selective_push_peer",
          rows.map((row) => row.id),
        );
        assertRowsIntegrated(afterDoc, rows, "selective_push_peer");
      } else {
        branchDoc = materializeBranch(branch);
        const wholeUpdate = computePushUpdate({ branch, branchDoc, liveDoc });
        Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
        Y.applyUpdate(afterDoc, wholeUpdate);
      }
      const pushUpdate =
        pushKind === "selective"
          ? Y.encodeStateAsUpdate(afterDoc, Y.encodeStateVector(liveDoc))
          : computePushUpdate({ branch, branchDoc: branchDoc as Y.Doc, liveDoc });
      const receipt = buildReceipt({
        model: input.model,
        documentId: branch.documentId,
        branch,
        pushKind,
        beforeDoc: liveDoc,
        afterDoc,
      });
      const markdownProjection = markdownFromDoc(input.model, input.codec, afterDoc);
      const liveState = Y.encodeStateAsUpdate(afterDoc);
      const liveStateVector = Y.encodeStateVector(afterDoc);
      const idempotencyKey = stablePushIdempotencyKey({
        branchId: branch.branchId,
        generation: branch.generation,
        journalIds: rows.map((row) => row.id),
        pushKind,
      });
      return {
        branch,
        rows,
        pushUpdate,
        receipt,
        markdownProjection,
        liveStateVector,
        liveState,
        idempotencyKey,
        receiptId: randomUUID(),
        conflictEcho:
          pushKind === "whole"
            ? conflictEchoFrom({
                currentBranch: branch,
                currentRows: rows,
                currentReceipt: receipt,
                priorPushes: await input.pushStore.listPushesForDocument?.(branch.documentId),
              })
            : undefined,
      };
    } finally {
      branchDoc?.destroy();
      afterDoc.destroy();
      liveDoc.destroy();
    }
  }

  async function listReviewableRows(
    branchId: string,
    generation: number,
  ): Promise<BranchJournalRow[]> {
    return (input.pushStore.listReviewableJournalRows ?? input.pushStore.listActiveJournalRows)(
      branchId,
      generation,
    );
  }

  async function withActiveWorkDraftBranchLock<T>(
    branchIds: readonly string[],
    run: (branches: readonly BranchSnapshot[]) => Promise<T>,
  ): Promise<T> {
    const retryBranchId = branchIds[0];
    if (!retryBranchId) throw new Error("active work draft lock requires at least one branch");
    for (let attempt = 0; attempt <= maxCasRetries; attempt += 1) {
      try {
        const branchesForLock = await Promise.all(
          branchIds.map(async (branchId) => ({
            branchId,
            branch: await input.branchStore.getBranch(branchId),
          })),
        );
        const lockKeys = [
          ...new Set(
            branchesForLock.map(({ branchId, branch }) =>
              documentMutationLockKey(branch?.documentId ?? branchId),
            ),
          ),
        ].sort();
        return await runWithDocumentMutationLocks(lockKeys, async () => {
          const branches = await Promise.all(branchIds.map(loadActiveWorkDraftBranch));
          return run(branches);
        });
      } catch (cause) {
        if (cause instanceof BranchPushCommitConflictError) {
          if (attempt >= maxCasRetries) {
            throw new BranchPushRetryExhaustedError(cause.branchId, maxCasRetries, cause);
          }
          continue;
        }
        throw cause;
      }
    }
    throw new BranchPushRetryExhaustedError(retryBranchId, maxCasRetries);
  }

  async function loadActiveWorkDraftBranch(branchId: string): Promise<BranchSnapshot> {
    return assertActiveWorkDraftBranch(await input.branchStore.getBranch(branchId), branchId);
  }

  async function runWithDocumentMutationLocks<T>(
    lockKeys: readonly string[],
    run: () => Promise<T>,
  ): Promise<T> {
    const [lockKey, ...rest] = lockKeys;
    if (!lockKey) return run();
    return mutex.run(lockKey, () => runWithDocumentMutationLocks(rest, run));
  }

  function mapNoActiveRows(cause: unknown): PushToLiveResult | null {
    if (cause instanceof NoActiveRowsExistingPush) {
      return { status: "already_pushed", push: cause.push };
    }
    if (cause instanceof NoActiveRowsNoop) {
      return {
        status: "noop",
        branchId: cause.branch.branchId,
        documentId: cause.branch.documentId,
        branchGeneration: cause.branch.generation,
        reason: "no_active_rows",
      };
    }
    return null;
  }

  async function resetAutoBranchIfDrained(
    branch: BranchSnapshot,
    liveAfterPush: Uint8Array,
    targetPolicy: "manual" | "auto" = branch.pushPolicy,
  ): Promise<{ branchId: string; fromGeneration: number } | undefined> {
    if (targetPolicy !== "auto" || !input.branchCoordinator) return undefined;
    const activeRows = await input.pushStore.listActiveJournalRows(
      branch.branchId,
      branch.generation,
    );
    if (activeRows.length > 0) return undefined;
    const fromGeneration = branch.generation;
    const liveDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(liveDoc, liveAfterPush);
    const reset = await input.branchCoordinator.resetFromDocIfUnchanged({
      branchId: branch.branchId,
      upstream: liveDoc,
      expectedGeneration: branch.generation,
      expectedStateVector: branch.stateVector,
      expectedState: branch.state,
      schemaVersion: branch.schemaVersion,
    });
    return reset ? { branchId: branch.branchId, fromGeneration } : undefined;
  }

  async function pushToLive(inputPush: {
    branchId: string;
    pushedByUserId?: UserId;
    resetPolicy?: "manual" | "auto";
  }): Promise<PushToLiveResult> {
    return withActiveWorkDraftBranchLock([inputPush.branchId], async ([branch]) => {
      // Phase 1: read-only compute. No branch coordinator lock and no live coordinator lock.
      let phase1: Awaited<ReturnType<typeof compute>>;
      try {
        phase1 = await compute(branch);
      } catch (cause) {
        const mapped = mapNoActiveRows(cause);
        if (mapped) return mapped;
        throw cause;
      }

      // Phase 2: durable commit. The live journal row and lineage commit before live memory moves.
      const committed = await input.pushStore.commitPush({
        branch: phase1.branch,
        journalRows: phase1.rows,
        pushUpdate: phase1.pushUpdate,
        receiptPayload: phase1.receipt,
        idempotencyKey: phase1.idempotencyKey,
        receiptId: phase1.receiptId,
        markdownProjection: phase1.markdownProjection,
        liveStateVector: phase1.liveStateVector,
        liveState: phase1.liveState,
        pushedByUserId: inputPush.pushedByUserId,
      });
      if (committed.status === "conflict") {
        return {
          status: "already_pushed",
          push: committed.push,
          conflictEcho: phase1.conflictEcho,
        };
      }

      // Phase 3: apply the committed bytes under the live lock after durability.
      const liveAfterPush = await input.liveCoordinator.withDocument(
        phase1.branch.documentId,
        async (liveDoc) => {
          Y.applyUpdate(liveDoc, phase1.pushUpdate);
          return Y.encodeStateAsUpdate(liveDoc);
        },
      );

      const branchReset = await resetAutoBranchIfDrained(
        phase1.branch,
        liveAfterPush,
        inputPush.resetPolicy,
      );

      return {
        status: "pushed",
        push: committed.push,
        update: phase1.pushUpdate,
        ...(phase1.conflictEcho ? { conflictEcho: phase1.conflictEcho } : {}),
        ...(branchReset ? { branchReset } : {}),
      };
    });
  }

  async function pushToLiveWithManifestEntry(inputPush: {
    branchId: string;
    manifestBranchId: string;
    manifestEntryDocumentId: DocumentId;
    contentJournalIds?: readonly number[];
    pushedByUserId?: UserId;
  }): Promise<PushToLiveResult> {
    if (!input.pushStore.commitPushBatch) {
      throw new Error("Branch push store does not support atomic companion pushes");
    }
    return withActiveWorkDraftBranchLock(
      [inputPush.branchId, inputPush.manifestBranchId],
      async ([contentBranch, manifestBranch]) => {
        let content: Awaited<ReturnType<typeof compute>>;
        try {
          const contentJournalIds = inputPush.contentJournalIds
            ? new Set(inputPush.contentJournalIds)
            : null;
          content = await compute(
            contentBranch,
            contentJournalIds
              ? {
                  pushKind: "selective",
                  selectRows: (row) => contentJournalIds.has(row.id),
                }
              : undefined,
          );
          if (contentJournalIds && content.rows.length !== contentJournalIds.size) {
            throw new BranchPushCommitConflictError(inputPush.branchId);
          }
        } catch (cause) {
          const mapped = mapNoActiveRows(cause);
          if (mapped) return mapped;
          throw cause;
        }

        let manifest: Awaited<ReturnType<typeof compute>> | null = null;
        try {
          manifest = await compute(manifestBranch, {
            pushKind: "selective",
            selectRows: (row) =>
              manifestMembershipRowDocumentId(row) === inputPush.manifestEntryDocumentId,
          });
        } catch (cause) {
          if (
            !(cause instanceof NoActiveRowsNoop) &&
            !(cause instanceof NoActiveRowsExistingPush)
          ) {
            throw cause;
          }
        }

        const receiptId = randomUUID();
        const pushes = [content, ...(manifest ? [manifest] : [])].map((phase) => ({
          branch: phase.branch,
          journalRows: phase.rows,
          pushUpdate: phase.pushUpdate,
          receiptPayload: phase.receipt,
          idempotencyKey: phase.idempotencyKey,
          receiptId,
          markdownProjection: phase.markdownProjection,
          liveStateVector: phase.liveStateVector,
          liveState: phase.liveState,
          pushedByUserId: inputPush.pushedByUserId,
        }));
        const committed =
          pushes.length === 1
            ? {
                pushes: [(await input.pushStore.commitPush(pushes[0] as PreparedPushCommit)).push],
              }
            : await input.pushStore.commitPushBatch?.({
                pushes: pushes as PreparedPushCommit[],
              });
        if (!committed) throw new Error("Branch push batch did not commit");

        for (const phase of [content, ...(manifest ? [manifest] : [])]) {
          await input.liveCoordinator.withDocument(phase.branch.documentId, async (liveDoc) => {
            Y.applyUpdate(liveDoc, phase.pushUpdate);
          });
        }

        return {
          status: "pushed",
          push: committed.pushes[0] as PushLineageRow,
          update: content.pushUpdate,
          ...(content.conflictEcho ? { conflictEcho: content.conflictEcho } : {}),
        };
      },
    );
  }

  async function pushSelectedToLive(inputPush: {
    branchId: string;
    journalIds: readonly number[];
    pushedByUserId?: UserId;
  }): Promise<PushToLiveResult> {
    const selected = new Set(inputPush.journalIds);
    if (selected.size === 0) {
      throw new Error("selective_push_requires_rows");
    }
    return withActiveWorkDraftBranchLock([inputPush.branchId], async ([branch]) => {
      const phase1 = await compute(branch, {
        pushKind: "selective",
        selectRows: (row) => selected.has(row.id),
      });
      if (phase1.rows.length !== selected.size) {
        throw new BranchPushCommitConflictError(inputPush.branchId);
      }
      const committed = await input.pushStore.commitPush({
        branch: phase1.branch,
        journalRows: phase1.rows,
        pushUpdate: phase1.pushUpdate,
        receiptPayload: phase1.receipt,
        idempotencyKey: phase1.idempotencyKey,
        receiptId: phase1.receiptId,
        markdownProjection: phase1.markdownProjection,
        liveStateVector: phase1.liveStateVector,
        liveState: phase1.liveState,
        pushedByUserId: inputPush.pushedByUserId,
      });
      if (committed.status === "conflict")
        return { status: "already_pushed", push: committed.push };
      await input.liveCoordinator.withDocument(phase1.branch.documentId, async (liveDoc) => {
        Y.applyUpdate(liveDoc, phase1.pushUpdate);
      });
      return { status: "pushed", push: committed.push, update: phase1.pushUpdate };
    });
  }

  async function discardSelected(discardInput: {
    branchId: string;
    journalIds: readonly number[];
    reviewedByUserId?: UserId;
  }): Promise<
    | { status: "discarded"; branchId: string; journalIds: number[] }
    | { status: "nothing_to_undo"; branchId: string; journalIds: number[] }
  > {
    const commitDiscard = input.pushStore.commitDiscard;
    if (!commitDiscard) {
      throw new Error("Branch push store does not support selective discard");
    }
    const selected = new Set(discardInput.journalIds);
    if (selected.size === 0) throw new Error("selective_discard_requires_rows");
    return withActiveWorkDraftBranchLock([discardInput.branchId], async ([branch]) => {
      const reviewableRows = await listReviewableRows(branch.branchId, branch.generation);
      const rows = reviewableRows.filter((row) => selected.has(row.id));
      if (rows.length !== selected.size) {
        return {
          status: "nothing_to_undo" as const,
          branchId: branch.branchId,
          journalIds: [...selected].sort((a, b) => a - b),
        };
      }
      const liveDoc = await loadLiveDoc(branch.documentId);
      const peer = buildReversalPeer({ liveDoc, rows: reviewableRows, selectedIds: selected });
      const branchDoc = materializeBranch(branch);
      try {
        syncPeer(peer, branchDoc);
        const reversalUpdate = Y.encodeStateAsUpdate(branchDoc, branch.stateVector);
        const state = Y.encodeStateAsUpdate(branchDoc);
        const stateVector = Y.encodeStateVector(branchDoc);
        await commitDiscard({
          branch,
          journalRows: rows,
          state,
          stateVector,
          reviewedByUserId: discardInput.reviewedByUserId,
        });
        input.branchCoordinator?.broadcastUpdate?.({
          branchId: branch.branchId,
          update: reversalUpdate,
        });
        return {
          status: "discarded",
          branchId: branch.branchId,
          journalIds: [...selected].sort((a, b) => a - b),
        };
      } finally {
        liveDoc.destroy();
        peer.destroy();
        branchDoc.destroy();
      }
    });
  }

  async function reverseBranchTurn(turnInput: {
    branchId: string;
    threadId: ThreadId;
    turnId: TurnId;
    direction: "undo" | "redo";
    reviewedByUserId?: UserId;
  }): Promise<
    | { status: "reversed" | "reconciled"; branchId: string; journalIds: number[] }
    | {
        status: "cant_undo_dependent" | "nothing_to_undo" | "nothing_to_redo";
        branchId: string;
        journalIds: number[];
      }
  > {
    const listJournalRowsForTurn = input.pushStore.listJournalRowsForTurn;
    if (!listJournalRowsForTurn) {
      throw new Error("Branch push store does not support turn reversal");
    }
    if (turnInput.direction === "undo" && !input.pushStore.commitDiscard) {
      throw new Error("Branch push store does not support selective discard");
    }
    return withActiveWorkDraftBranchLock([turnInput.branchId], async ([branch]) => {
      if (turnInput.direction === "undo") {
        const rows = await listJournalRowsForTurn({
          branchId: branch.branchId,
          generation: branch.generation,
          threadId: turnInput.threadId,
          turnId: turnInput.turnId,
          statuses: ["active", "rollback_pending"],
        });
        const journalIds = rows.map((row) => row.id).sort((a, b) => a - b);
        if (journalIds.length === 0) {
          return { status: "nothing_to_undo" as const, branchId: branch.branchId, journalIds };
        }
        const reviewableRows = await listReviewableRows(branch.branchId, branch.generation);
        const laterRows = reviewableRows.filter(
          (row) => row.id > Math.max(...journalIds) && row.turnId !== turnInput.turnId,
        );
        if (hasDependentLaterRows(rows, laterRows)) {
          return { status: "cant_undo_dependent" as const, branchId: branch.branchId, journalIds };
        }

        const liveDoc = await loadLiveDoc(branch.documentId);
        const selected = new Set(journalIds);
        let peer: Y.Doc | null = null;
        const branchDoc = materializeBranch(branch);
        try {
          try {
            peer = buildReversalPeer({ liveDoc, rows: reviewableRows, selectedIds: selected });
          } catch (cause) {
            if (cause instanceof BranchPeerIntegrationError) {
              return {
                status: "cant_undo_dependent" as const,
                branchId: branch.branchId,
                journalIds,
              };
            }
            throw cause;
          }
          const reversalUpdate = Y.encodeStateAsUpdate(peer, branch.stateVector);
          Y.applyUpdate(branchDoc, reversalUpdate);
          await (input.pushStore.commitDiscard as NonNullable<BranchPushStore["commitDiscard"]>)({
            branch,
            journalRows: rows,
            state: Y.encodeStateAsUpdate(branchDoc),
            stateVector: Y.encodeStateVector(branchDoc),
            reviewedByUserId: turnInput.reviewedByUserId,
          });
          input.branchCoordinator?.broadcastUpdate?.({
            branchId: branch.branchId,
            update: reversalUpdate,
          });
          return { status: "reversed" as const, branchId: branch.branchId, journalIds };
        } finally {
          liveDoc.destroy();
          peer?.destroy();
          branchDoc.destroy();
        }
      }

      const commitTurnRedo = input.pushStore.commitTurnRedo;
      if (!commitTurnRedo) throw new Error("Branch push store does not support turn redo");
      const rows = await listJournalRowsForTurn({
        branchId: branch.branchId,
        generation: branch.generation,
        threadId: turnInput.threadId,
        turnId: turnInput.turnId,
        statuses: ["discarded"],
      });
      const selected = new Set(rows.map((row) => row.id));
      if (selected.size === 0) {
        return { status: "nothing_to_redo" as const, branchId: branch.branchId, journalIds: [] };
      }
      const liveDoc = await loadLiveDoc(branch.documentId);
      const branchRows = input.pushStore.listJournalRowsForBranch
        ? await input.pushStore.listJournalRowsForBranch({
            branchId: branch.branchId,
            generation: branch.generation,
          })
        : [
            ...(await input.pushStore.listActiveJournalRows(branch.branchId, branch.generation)),
            ...rows,
          ];
      const peer = buildRedoPeer({ liveDoc, rows: branchRows, selectedIds: selected });
      const branchDoc = materializeBranch(branch);
      try {
        const redoUpdate = syncPeer(peer, branchDoc);
        const collapsedRedoRow = [...rows].sort((a, b) => a.id - b.id)[0];
        if (!collapsedRedoRow) {
          return { status: "nothing_to_redo" as const, branchId: branch.branchId, journalIds: [] };
        }
        await commitTurnRedo({
          branch,
          journalRows: [collapsedRedoRow],
          replacementUpdateData: redoUpdate,
          state: Y.encodeStateAsUpdate(branchDoc),
          stateVector: Y.encodeStateVector(branchDoc),
          reviewedByUserId: turnInput.reviewedByUserId,
        });
        input.branchCoordinator?.broadcastUpdate?.({
          branchId: branch.branchId,
          update: redoUpdate,
        });
        return {
          status: "reconciled" as const,
          branchId: branch.branchId,
          journalIds: [collapsedRedoRow.id],
        };
      } finally {
        liveDoc.destroy();
        peer.destroy();
        branchDoc.destroy();
      }
    });
  }

  async function getTurnChangeDiff(diffInput: { threadId: ThreadId; turnId: TurnId }): Promise<{
    version: 1;
    source: "pushed" | "branch";
    documents: Array<{
      documentId: DocumentId;
      documentTitle: string;
      blocks: ReceiptBlockChange[];
    }>;
  }> {
    const pushed = await input.pushStore.listPushLineageForTurn?.(diffInput);
    const pushedDocs = await Promise.all(
      (pushed ?? [])
        .filter(
          (row): row is PushLineageRow & { receiptPayload: PushReceiptPayload } =>
            row.receiptPayload !== null,
        )
        .map(async (row) => ({
          documentId: row.documentId,
          documentTitle: await resolveDocumentTitle(row.documentId),
          blocks: row.receiptPayload.changedBlocks,
        })),
    );

    if (!input.pushStore.listJournalRowsForTurn || !input.pushStore.listJournalRowsForBranch) {
      if (pushedDocs.length > 0) return { version: 1, source: "pushed", documents: pushedDocs };
      throw new Error("Branch push store does not support turn diff receipts");
    }
    const turnRows = await input.pushStore.listJournalRowsForTurn({
      threadId: diffInput.threadId,
      turnId: diffInput.turnId,
      statuses: ["active", "discarded", "rollback_pending"],
    });
    const documents = [...pushedDocs];
    for (const [branchKey, rows] of groupRowsByBranchGeneration(turnRows)) {
      const [branchId, generationText] = branchKey.split(":");
      const generation = Number(generationText);
      const branch = await input.branchStore.getBranch(branchId as string);
      if (!branch || !Number.isInteger(generation)) continue;
      const selected = new Set(rows.map((row) => row.id));
      const throughJournalId = Math.max(...rows.map((row) => row.id));
      const branchRows = await input.pushStore.listJournalRowsForBranch({
        branchId: branchId as string,
        generation,
        throughJournalId,
      });
      const baseDoc = await loadLiveDoc(branch.documentId);
      const beforeDoc = createCollabYDoc({ gc: false });
      const afterDoc = createCollabYDoc({ gc: false });
      try {
        Y.applyUpdate(beforeDoc, Y.encodeStateAsUpdate(baseDoc));
        Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(baseDoc));
        for (const row of branchRows) {
          if (selected.has(row.id)) {
            Y.applyUpdate(afterDoc, row.updateData);
          } else {
            Y.applyUpdate(beforeDoc, row.updateData);
            Y.applyUpdate(afterDoc, row.updateData);
          }
        }
        // Spec §1 peers+sync-once exception: these are reporting-only scratch peers.
        // They derive a View-change receipt and never sync or propagate anywhere.
        const receipt = buildReceipt({
          model: input.model,
          documentId: branch.documentId,
          branch: { ...branch, generation },
          pushKind: "selective",
          beforeDoc,
          afterDoc,
        });
        documents.push({
          documentId: branch.documentId,
          documentTitle: await resolveDocumentTitle(branch.documentId),
          blocks: receipt.changedBlocks,
        });
      } finally {
        baseDoc.destroy();
        beforeDoc.destroy();
        afterDoc.destroy();
      }
    }
    return { version: 1, source: pushedDocs.length > 0 ? "pushed" : "branch", documents };
  }

  async function resolveDocumentTitle(documentId: DocumentId): Promise<string> {
    const resolved = (await input.resolveDocumentTitle?.(documentId))?.trim();
    return resolved || "Untitled document";
  }

  return {
    pushToLive,
    pushSelectedToLive,
    discardSelected,
    reverseBranchTurn,
    pushToLiveWithManifestEntry,

    async pushAutoBranchAfterThreadPeerWrite(autoInput) {
      const branch = await input.branchStore.getBranch(autoInput.workDraftBranchId);
      if (branch?.kind !== "work_draft" || branch.status !== "active") {
        return { status: "skipped", reason: "not_active_work_draft" };
      }
      if (branch.pushPolicy !== "auto") return { status: "skipped", reason: "manual_policy" };
      return pushToLive({
        branchId: autoInput.workDraftBranchId,
        pushedByUserId: autoInput.pushedByUserId,
      });
    },

    async setWorkPushPolicy(policyInput) {
      if (policyInput.policy === "manual") {
        await input.pushStore.updateWorkDraftPushPolicy(policyInput.workId, "manual");
        return { status: "updated", policy: "manual" };
      }
      const unpushedCount = await input.pushStore.countUnpushedRowsForWork(policyInput.workId);
      if (unpushedCount > 0 && !policyInput.confirmedPush) {
        return {
          status: "confirmation_required",
          unpushedCount,
          reason: `Switching to Auto-apply will apply ${unpushedCount} pending changes.`,
        };
      }
      if (unpushedCount > 0) {
        for (const branchId of await input.pushStore.listActiveWorkDraftBranchIdsForWork(
          policyInput.workId,
        )) {
          await pushToLive({
            branchId,
            pushedByUserId: policyInput.pushedByUserId,
            resetPolicy: "auto",
          });
        }
      }
      await input.pushStore.updateWorkDraftPushPolicy(policyInput.workId, "auto");
      return { status: "updated", policy: "auto" };
    },

    async markFailedResponseRollbackPending(rollbackInput) {
      if (input.pushStore.listJournalRowsForTurn && input.pushStore.commitDiscard) {
        const reversed = await reverseBranchTurn({
          ...rollbackInput,
          direction: "undo",
        });
        if (reversed.status === "reversed") {
          return {
            status: "discarded",
            branchId: reversed.branchId,
            journalIds: reversed.journalIds,
          };
        }
      }
      const branch = await input.branchStore.getBranch(rollbackInput.branchId);
      if (!branch) throw new Error(`Branch ${rollbackInput.branchId} does not exist`);
      const rowsMarked = await input.pushStore.markRollbackPending({
        ...rollbackInput,
        generation: branch.generation,
      });
      return { status: "rollback_pending", rowsMarked };
    },

    async getTurnChangeDiff(diffInput) {
      return getTurnChangeDiff(diffInput);
    },
  };
}

export class BranchPushCommitConflictError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} changed before its push could commit`);
    this.name = "BranchPushCommitConflictError";
  }
}

class NoActiveRowsExistingPush extends Error {
  constructor(readonly push: PushLineageRow) {
    super("Branch has no active rows and already has a push lineage row");
  }
}

class NoActiveRowsNoop extends Error {
  constructor(readonly branch: BranchSnapshot) {
    super("Branch has no active rows and no prior lineage");
  }
}

function assertActiveWorkDraftBranch(
  branch: BranchSnapshot | null | undefined,
  branchId: string,
): BranchSnapshot {
  if (!branch) throw new Error(`Branch ${branchId} does not exist`);
  if (branch.kind !== "work_draft" || branch.status !== "active") {
    throw new Error(`Branch ${branchId} is not an active work draft`);
  }
  return branch;
}

const maxCasRetries = 3;

export class BranchPushRetryExhaustedError extends Error {
  constructor(
    readonly branchId: string,
    readonly maxRetries: number,
    cause?: unknown,
  ) {
    super(`Branch ${branchId} push did not commit after ${maxRetries} CAS retries`, { cause });
    this.name = "BranchPushRetryExhaustedError";
  }
}

function buildReversalPeer(input: {
  liveDoc: Y.Doc;
  rows: BranchJournalRow[];
  selectedIds: ReadonlySet<number>;
}): Y.Doc {
  const peer = createCollabYDoc({ gc: false });
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(input.liveDoc));
  const fragment = peer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const targetOrigin = Symbol("discard-target");
  const otherOrigin = Symbol("discard-survivor");
  const undoManager = new Y.UndoManager(fragment, {
    trackedOrigins: new Set([targetOrigin]),
    captureTimeout: Number.POSITIVE_INFINITY,
  });
  undoManager.stopCapturing();
  for (const row of input.rows) {
    Y.applyUpdate(peer, row.updateData, input.selectedIds.has(row.id) ? targetOrigin : otherOrigin);
  }
  assertNoPendingIntegration(
    peer,
    "selective_discard_peer",
    input.rows.map((row) => row.id),
  );
  undoManager.stopCapturing();
  while (undoManager.undoStack.length > 0) {
    undoManager.undo();
    undoManager.stopCapturing();
  }
  assertNoPendingIntegration(
    peer,
    "selective_discard_peer_after_undo",
    input.rows.map((row) => row.id),
  );
  return peer;
}

function buildRedoPeer(input: {
  liveDoc: Y.Doc;
  rows: BranchJournalRow[];
  selectedIds: ReadonlySet<number>;
}): Y.Doc {
  const peer = createCollabYDoc({ gc: false });
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(input.liveDoc));
  const fragment = peer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const redoOrigin = Symbol("turn-redo-target");
  const otherOrigin = Symbol("turn-redo-survivor");
  const undoManager = new Y.UndoManager(fragment, {
    trackedOrigins: new Set([redoOrigin]),
    captureTimeout: Number.POSITIVE_INFINITY,
  });
  undoManager.stopCapturing();
  for (const row of input.rows) {
    Y.applyUpdate(peer, row.updateData, input.selectedIds.has(row.id) ? redoOrigin : otherOrigin);
  }
  assertNoPendingIntegration(
    peer,
    "turn_redo_peer",
    input.rows.map((row) => row.id),
  );
  undoManager.stopCapturing();
  while (undoManager.undoStack.length > 0) {
    undoManager.undo();
    undoManager.stopCapturing();
  }
  while (undoManager.redoStack.length > 0) {
    undoManager.redo();
    undoManager.stopCapturing();
  }
  assertNoPendingIntegration(
    peer,
    "turn_redo_peer_after_redo",
    input.rows.map((row) => row.id),
  );
  return peer;
}

function groupRowsByBranchGeneration(
  rows: readonly BranchJournalRow[],
): Map<string, BranchJournalRow[]> {
  const grouped = new Map<string, BranchJournalRow[]>();
  for (const row of rows) {
    const key = `${row.branchId}:${row.generation}`;
    const branchRows = grouped.get(key) ?? [];
    branchRows.push(row);
    grouped.set(key, branchRows);
  }
  return grouped;
}

function syncPeer(from: Y.Doc, to: Y.Doc): Uint8Array {
  const update = Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));
  Y.applyUpdate(to, update);
  return update;
}

export class BranchPeerIntegrationError extends Error {
  constructor(
    readonly operation: string,
    readonly journalIds: readonly number[],
  ) {
    super(`${operation} left pending Yjs dependencies for journal rows ${journalIds.join(",")}`);
    this.name = "BranchPeerIntegrationError";
  }
}

function assertNoPendingIntegration(
  doc: Y.Doc,
  operation: string,
  journalIds: readonly number[],
): void {
  const store = (doc as unknown as { store?: { pendingStructs?: unknown; pendingDs?: unknown } })
    .store;
  if (hasPending(store?.pendingStructs) || hasPending(store?.pendingDs)) {
    throw new BranchPeerIntegrationError(operation, journalIds);
  }
}

function hasPending(value: unknown): boolean {
  if (value == null) return false;
  if (value instanceof Uint8Array) return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export class BranchPushEffectVerificationError extends Error {
  constructor(
    readonly operation: string,
    readonly journalIds: readonly number[],
    readonly reason: string,
  ) {
    super(
      `${operation} did not integrate selected Yjs effects (${reason}) for journal rows ${journalIds.join(",")}`,
    );
    this.name = "BranchPushEffectVerificationError";
  }
}

function assertRowsIntegrated(
  doc: Y.Doc,
  rows: readonly BranchJournalRow[],
  operation: string,
): void {
  const stateVector = Y.decodeStateVector(Y.encodeStateVector(doc));
  const docDeleteRanges = deleteRanges(decodeUpdateForDependencies(Y.encodeStateAsUpdate(doc)));
  for (const row of rows) {
    const decoded = decodeUpdateForDependencies(row.updateData);
    for (const range of suppliedRanges(decoded)) {
      if ((stateVector.get(range.client) ?? 0) < range.clock + range.length) {
        throw new BranchPushEffectVerificationError(operation, [row.id], "missing_struct_range");
      }
    }
    for (const range of deleteRanges(decoded)) {
      if (!docDeleteRanges.some((candidate) => rangeCovers(candidate, range))) {
        throw new BranchPushEffectVerificationError(operation, [row.id], "missing_delete_range");
      }
    }
  }
}

function conflictEchoFrom(input: {
  currentBranch: BranchSnapshot;
  currentRows: BranchJournalRow[];
  currentReceipt: PushReceiptPayload;
  priorPushes?: PushLineageRow[];
}): BranchPushConflictEcho | undefined {
  const currentChanged = new Set(input.currentReceipt.changedBlocks.map((block) => block.blockId));
  if (currentChanged.size === 0) return undefined;
  const concurrentPushes: BranchPushConflictEcho["concurrentPushes"] = [];
  const overlapping = new Set<string>();
  for (const push of input.priorPushes ?? []) {
    if (push.branchId === input.currentBranch.branchId) continue;
    const priorReceipt = push.receiptPayload;
    if (!priorReceipt) continue;
    const priorGeneration = priorReceipt.branchGeneration;
    if (
      push.branchId === input.currentBranch.upstreamBranchId &&
      priorGeneration <= input.currentBranch.generation
    ) {
      continue;
    }
    const overlap = priorReceipt.changedBlocks
      .filter(
        (block) =>
          currentChanged.has(block.blockId) &&
          !priorBlockIsInCurrentBase(
            block,
            priorReceipt,
            input.currentBranch,
            input.currentReceipt,
          ),
      )
      .map((block) => block.blockId);
    if (overlap.length === 0) continue;
    for (const blockId of overlap) overlapping.add(blockId);
    concurrentPushes.push({
      id: push.id,
      branchId: push.branchId,
      threadId: push.threadId ?? null,
      turnId: push.turnId ?? null,
      journalIds: push.journalIds,
    });
  }
  if (overlapping.size === 0) return undefined;
  return {
    overlappingBlockIds: [...overlapping].sort(),
    current: input.currentRows.map((row) => ({
      id: row.id,
      branchId: row.branchId,
      source: row.source,
      threadId: row.threadId,
      turnId: row.turnId,
      wId: row.wId,
    })),
    concurrentPushes,
  };
}

function priorBlockIsInCurrentBase(
  priorBlock: ReceiptBlockChange,
  priorReceipt: PushReceiptPayload,
  currentBranch: BranchSnapshot,
  currentReceipt: PushReceiptPayload,
): boolean {
  if (priorReceipt.branchGeneration >= currentBranch.generation) return false;
  const currentBlock = currentReceipt.changedBlocks.find(
    (block) => block.blockId === priorBlock.blockId,
  );
  return currentBlock ? priorBlock.afterText === currentBlock.beforeText : false;
}

function wholeBranchPushUpdate(input: { branchDoc: Y.Doc; liveDoc: Y.Doc }): Uint8Array {
  return Y.encodeStateAsUpdate(input.branchDoc, Y.encodeStateVector(input.liveDoc));
}

function buildReceipt(input: {
  model: YProsemirrorDocumentModel;
  documentId: DocumentId;
  branch: BranchSnapshot;
  pushKind: "whole" | "selective";
  beforeDoc: Y.Doc;
  afterDoc: Y.Doc;
}): PushReceiptPayload {
  const before = blockTextMap(input.model, input.beforeDoc);
  const after = blockTextMap(input.model, input.afterDoc);
  const blockIds = new Set([...before.keys(), ...after.keys()]);
  const changedBlocks = [...blockIds]
    .filter((blockId) => before.get(blockId) !== after.get(blockId))
    .sort()
    .map((blockId) => {
      const beforeText = before.get(blockId) ?? null;
      const afterText = after.get(blockId) ?? null;
      const beforeWordCount = wordCount(beforeText ?? "");
      const afterWordCount = wordCount(afterText ?? "");
      return {
        blockId,
        beforeText,
        afterText,
        beforeWordCount,
        afterWordCount,
        wordDelta: afterWordCount - beforeWordCount,
      };
    });
  return {
    version: 1,
    documentId: input.documentId,
    branchId: input.branch.branchId,
    branchGeneration: input.branch.generation,
    pushKind: input.pushKind,
    changedBlocks,
    totalWordDelta: changedBlocks.reduce((sum, row) => sum + row.wordDelta, 0),
  };
}

function blockTextMap(model: YProsemirrorDocumentModel, doc: Y.Doc): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of model.getBlocks(toDocHandle(doc))) {
    result.set(model.getBlockId(block), model.getText(block));
  }
  return result;
}

function markdownFromDoc(model: YProsemirrorDocumentModel, codec: MarkupCodec, doc: Y.Doc): string {
  const blocks = model.getBlocks(toDocHandle(doc));
  return blocks.length === 0 ? "" : codec.serialize(model.projectBlocks(toDocHandle(doc)));
}

function wordCount(text: string): number {
  return text.trim() ? (text.trim().match(/\S+/g) ?? []).length : 0;
}

function stablePushIdempotencyKey(input: {
  branchId: string;
  generation: number;
  journalIds: number[];
  pushKind: "whole" | "selective";
}): string {
  return createHash("sha256")
    .update(input.branchId)
    .update("\0")
    .update(String(input.generation))
    .update("\0")
    .update(input.pushKind)
    .update("\0")
    .update([...input.journalIds].sort((a, b) => a - b).join(","))
    .digest("hex");
}

function manifestMembershipRowDocumentId(row: BranchJournalRow): DocumentId | null {
  const meta = row.updateMeta;
  if (typeof meta !== "object" || meta === null) return null;
  const record = meta as { kind?: unknown; documentId?: unknown };
  return record.kind === "manifest_membership" && typeof record.documentId === "string"
    ? (record.documentId as DocumentId)
    : null;
}
