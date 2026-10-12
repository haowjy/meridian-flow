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
  type BranchTurnReversal,
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
    if (branchIds.length === 0) throw new Error("active work draft lock requires a branch");
    return criticalSections.withBranches(branchIds, () => retryingCas(branchIds, run));
  }

  /** Re-reads the branches and runs again when another process moved one under us. */
  async function retryingCas<T>(
    branchIds: readonly string[],
    run: (branches: readonly BranchSnapshot[]) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const branches = await Promise.all(
          branchIds.map(async (branchId) =>
            assertActiveWorkDraftBranch(await deps.branchStore.getBranch(branchId), branchId),
          ),
        );
        return await run(branches);
      } catch (cause) {
        if (!(cause instanceof BranchPushCommitConflictError)) throw cause;
        if (attempt >= maxCasRetries) {
          throw new BranchPushRetryExhaustedError(cause.branchId, maxCasRetries, cause);
        }
      }
    }
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

  async function reverseBranchTurns(turnInput: {
    branchIds: readonly string[];
    threadId: ThreadId;
    turnId: TurnId;
    direction: "undo" | "redo";
    reviewedByUserId?: UserId;
  }): Promise<BranchTurnReversal[]> {
    const branchIds = [...new Set(turnInput.branchIds)];
    if (branchIds.length === 0) return [];
    // Branch critical sections, then every branch's Work once, then each
    // branch's change-trail and document locks (file-access §5). A concurrent
    // push holds its branch section while it waits for the Work row.
    return criticalSections.withBranches(branchIds, async () => {
      const frozen = await deps.commitStore.lockDraftWorks(branchIds);
      const results: BranchTurnReversal[] = [];
      for (const branchId of branchIds) {
        results.push(
          frozen.has(branchId)
            ? { status: "permission_denied", branchId, journalIds: [] }
            : await retryingCas([branchId], ([branch]) => reverseOneBranchTurn(branch, turnInput)),
        );
      }
      return results;
    });
  }

  async function reverseOneBranchTurn(
    branch: BranchSnapshot,
    turnInput: {
      threadId: ThreadId;
      turnId: TurnId;
      direction: "undo" | "redo";
      reviewedByUserId?: UserId;
    },
  ): Promise<BranchTurnReversal> {
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
    const commit = {
      branch,
      journalRows: prepared.journalRows,
      state: prepared.state,
      stateVector: prepared.stateVector,
      reviewedByUserId: turnInput.reviewedByUserId,
    };
    if (turnInput.direction === "undo") await deps.commitStore.commitDiscard(commit);
    else await deps.commitStore.commitTurnRedo(commit);
    broadcastAfterCommit({ branchId: branch.branchId, update: prepared.publishUpdate });
    return {
      status: prepared.status,
      branchId: branch.branchId,
      journalIds: prepared.journalIds,
    };
  }

  return {
    discardSelected,
    reverseBranchTurns,
    async markFailedResponseRollbackPending(rollbackInput) {
      const [reversed] = await reverseBranchTurns({
        branchIds: [rollbackInput.branchId],
        threadId: rollbackInput.threadId,
        turnId: rollbackInput.turnId,
        direction: "undo",
      });
      if (!reversed) throw new Error(`Branch ${rollbackInput.branchId} was not reversed`);
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
