/** Selective discard and turn-level undo/redo operations for work-draft review. */
import type { ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type { BranchJournalRow, BranchPushStore } from "./branch-push.js";
import { assertNoPendingIntegration, BranchPeerIntegrationError } from "./branch-push-plan.js";
import { hasDependentLaterRows } from "./journal-dependencies.js";

type Dependencies = {
  pushStore: BranchPushStore;
  broadcastUpdate?: (input: { branchId: string; update: Uint8Array }) => void;
  withActiveWorkDraftBranchLock<T>(
    branchIds: readonly string[],
    run: (branches: readonly BranchSnapshot[]) => Promise<T>,
  ): Promise<T>;
  listReviewableRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  loadLiveDoc(documentId: BranchSnapshot["documentId"]): Promise<Y.Doc>;
  materializeBranch(branch: BranchSnapshot): Y.Doc;
};

export function createBranchReviewOperations(deps: Dependencies) {
  const input = {
    pushStore: deps.pushStore,
    branchCoordinator: { broadcastUpdate: deps.broadcastUpdate },
  };
  const { withActiveWorkDraftBranchLock, listReviewableRows, loadLiveDoc, materializeBranch } =
    deps;
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

  return { discardSelected, reverseBranchTurn };
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

function syncPeer(from: Y.Doc, to: Y.Doc): Uint8Array {
  const update = Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));
  Y.applyUpdate(to, update);
  return update;
}
