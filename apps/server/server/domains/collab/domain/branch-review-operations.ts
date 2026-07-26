/** Standalone selective discard and turn-level undo/redo service for work-draft review. */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import {
  type BranchCriticalSections,
  createBranchCriticalSections,
} from "./branch-critical-sections.js";
import {
  type BranchJournalReadStore,
  type BranchJournalRow,
  BranchPushCommitConflictError,
  BranchPushRetryExhaustedError,
  type BranchReviewService,
  type PushCommitStore,
} from "./branch-push-contracts.js";
import { assertNoPendingIntegration } from "./branch-push-plan.js";
import { createBranchTurnReversalPlanner } from "./branch-turn-reversal-plan.js";

type Dependencies = {
  branchStore: BranchStore;
  journalReadStore: BranchJournalReadStore;
  commitStore: PushCommitStore;
  branchCoordinator?: Partial<Pick<BranchCoordinator, "broadcastUpdate">>;
  deferUntilCommit?(operation: () => void | Promise<void>): boolean;
  journal: UpdateJournal;
  criticalSections?: BranchCriticalSections;
};

export function createBranchReviewOperations(deps: Dependencies): BranchReviewService {
  const criticalSections = deps.criticalSections ?? createBranchCriticalSections();
  const prepareBranchTurnReversal = createBranchTurnReversalPlanner(deps);

  function broadcastAfterCommit(input: { branchId: string; update: Uint8Array }): void {
    const broadcast = () => deps.branchCoordinator?.broadcastUpdate?.(input);
    if (!deps.deferUntilCommit?.(broadcast)) broadcast();
  }

  async function listReviewableRows(
    branchId: string,
    generation: number,
  ): Promise<BranchJournalRow[]> {
    return deps.journalReadStore.listReviewableJournalRows(branchId, generation);
  }

  async function loadLiveDoc(documentId: BranchSnapshot["documentId"]): Promise<Y.Doc> {
    const snapshot = await deps.journal.read(documentId);
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

  async function withActiveWorkDraftBranchLock<T>(
    branchIds: readonly string[],
    run: (branches: readonly BranchSnapshot[]) => Promise<T>,
  ): Promise<T> {
    const retryBranchId = branchIds[0];
    if (!retryBranchId) throw new Error("active work draft lock requires at least one branch");
    for (let attempt = 0; attempt <= maxCasRetries; attempt += 1) {
      try {
        return await criticalSections.withBranches(branchIds, async () => {
          const branches = await Promise.all(
            branchIds.map(async (branchId) =>
              assertActiveWorkDraftBranch(await deps.branchStore.getBranch(branchId), branchId),
            ),
          );
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

  async function discardSelected(discardInput: {
    branchId: string;
    journalIds: readonly number[];
    reviewedByUserId?: UserId;
  }): Promise<
    | { status: "discarded"; branchId: string; journalIds: number[] }
    | { status: "nothing_to_undo"; branchId: string; journalIds: number[] }
  > {
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
        await deps.commitStore.commitDiscard({
          branch,
          journalRows: rows,
          state,
          stateVector,
          reviewedByUserId: discardInput.reviewedByUserId,
        });
        broadcastAfterCommit({
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
    return withActiveWorkDraftBranchLock([turnInput.branchId], async ([branch]) => {
      const prepared = await prepareBranchTurnReversal({
        branch,
        threadId: turnInput.threadId,
        turnId: turnInput.turnId,
        direction: turnInput.direction,
      });
      if (!prepared.ok) {
        return {
          status: prepared.status,
          branchId: branch.branchId,
          journalIds: prepared.journalIds,
        };
      }
      if (turnInput.direction === "undo") {
        await deps.commitStore.commitDiscard({
          branch,
          journalRows: prepared.journalRows,
          state: prepared.state,
          stateVector: prepared.stateVector,
          reviewedByUserId: turnInput.reviewedByUserId,
        });
      } else {
        await deps.commitStore.commitTurnRedo({
          branch,
          journalRows: prepared.journalRows,
          state: prepared.state,
          stateVector: prepared.stateVector,
          reviewedByUserId: turnInput.reviewedByUserId,
        });
      }
      broadcastAfterCommit({ branchId: branch.branchId, update: prepared.publishUpdate });
      return {
        status: prepared.status,
        branchId: branch.branchId,
        journalIds: prepared.journalIds,
      };
    });
  }

  return {
    discardSelected,
    reverseBranchTurn,
    async markFailedResponseRollbackPending(rollbackInput) {
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
      const branch = await deps.branchStore.getBranch(rollbackInput.branchId);
      if (!branch) throw new Error(`Branch ${rollbackInput.branchId} does not exist`);
      const rowsMarked = await deps.commitStore.markRollbackPending({
        ...rollbackInput,
        generation: branch.generation,
      });
      return { status: "rollback_pending", rowsMarked };
    },
  };
}

const maxCasRetries = 3;

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

function syncPeer(from: Y.Doc, to: Y.Doc): Uint8Array {
  const update = Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));
  Y.applyUpdate(to, update);
  return update;
}
