/** Canonical preparation for Work-draft turn undo/redo. */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type { BranchJournalReadStore, BranchJournalRow } from "./branch-push-contracts.js";
import { assertNoPendingIntegration, BranchPeerIntegrationError } from "./branch-push-plan.js";
import { hasDependentLaterRows } from "./journal-dependencies.js";

export type PreparedBranchTurnReversal =
  | {
      ok: true;
      status: "reversed" | "reconciled";
      journalRows: BranchJournalRow[];
      journalIds: number[];
      state: Uint8Array;
      stateVector: Uint8Array;
      publishUpdate: Uint8Array;
    }
  | {
      ok: false;
      status: "cant_undo_dependent" | "nothing_to_undo" | "nothing_to_redo";
      journalIds: number[];
    };

export function createBranchTurnReversalPlanner(deps: {
  journalReadStore: Pick<
    BranchJournalReadStore,
    "listJournalRowsForTurn" | "listReviewableJournalRows" | "listJournalRowsForBranch"
  >;
  journal: Pick<UpdateJournal, "read">;
}) {
  return async function prepareBranchTurnReversal(input: {
    branch: BranchSnapshot;
    threadId: ThreadId;
    turnId: TurnId;
    direction: "undo" | "redo";
  }): Promise<PreparedBranchTurnReversal> {
    return input.direction === "undo" ? prepareUndo(deps, input) : prepareRedo(deps, input);
  };
}

async function prepareUndo(
  deps: Parameters<typeof createBranchTurnReversalPlanner>[0],
  input: {
    branch: BranchSnapshot;
    threadId: ThreadId;
    turnId: TurnId;
  },
): Promise<PreparedBranchTurnReversal> {
  const rows = await deps.journalReadStore.listJournalRowsForTurn({
    branchId: input.branch.branchId,
    generation: input.branch.generation,
    threadId: input.threadId,
    turnId: input.turnId,
    statuses: ["active", "rollback_pending"],
  });
  const journalIds = rows.map((row) => row.id).sort((a, b) => a - b);
  if (journalIds.length === 0) return { ok: false, status: "nothing_to_undo", journalIds };

  const reviewableRows = await deps.journalReadStore.listReviewableJournalRows(
    input.branch.branchId,
    input.branch.generation,
  );
  const laterRows = reviewableRows.filter(
    (row) => row.id > Math.max(...journalIds) && row.turnId !== input.turnId,
  );
  if (hasDependentLaterRows(rows, laterRows)) {
    return { ok: false, status: "cant_undo_dependent", journalIds };
  }

  return materializePlan(deps, input.branch, rows, journalIds, (liveDoc) =>
    buildReversalPeer({
      liveDoc,
      rows: reviewableRows,
      selectedIds: new Set(journalIds),
    }),
  );
}

async function prepareRedo(
  deps: Parameters<typeof createBranchTurnReversalPlanner>[0],
  input: {
    branch: BranchSnapshot;
    threadId: ThreadId;
    turnId: TurnId;
  },
): Promise<PreparedBranchTurnReversal> {
  const rows = await deps.journalReadStore.listJournalRowsForTurn({
    branchId: input.branch.branchId,
    generation: input.branch.generation,
    threadId: input.threadId,
    turnId: input.turnId,
    statuses: ["discarded"],
  });
  const journalIds = rows.map((row) => row.id).sort((a, b) => a - b);
  if (journalIds.length === 0) return { ok: false, status: "nothing_to_redo", journalIds };
  const selectedIds = new Set(journalIds);
  const branchRows = (
    await deps.journalReadStore.listJournalRowsForBranch({
      branchId: input.branch.branchId,
      generation: input.branch.generation,
    })
  ).filter(
    (row) =>
      row.status === "active" || row.status === "rollback_pending" || selectedIds.has(row.id),
  );
  return materializePlan(
    deps,
    input.branch,
    rows,
    journalIds,
    (liveDoc) => buildRedoPeer({ liveDoc, rows: branchRows, selectedIds }),
    "reconciled",
  );
}

async function materializePlan(
  deps: Parameters<typeof createBranchTurnReversalPlanner>[0],
  branch: BranchSnapshot,
  rows: BranchJournalRow[],
  journalIds: number[],
  buildPeer: (liveDoc: Y.Doc) => Y.Doc,
  status: "reversed" | "reconciled" = "reversed",
): Promise<PreparedBranchTurnReversal> {
  const liveDoc = await loadLiveDoc(deps.journal, branch.documentId);
  const branchDoc = materializeBranch(branch);
  let peer: Y.Doc | null = null;
  try {
    peer = buildPeer(liveDoc);
    const publishUpdate = syncPeer(peer, branchDoc);
    return {
      ok: true,
      status,
      journalRows: rows,
      journalIds,
      state: Y.encodeStateAsUpdate(branchDoc),
      stateVector: Y.encodeStateVector(branchDoc),
      publishUpdate,
    };
  } catch (cause) {
    if (cause instanceof BranchPeerIntegrationError) {
      return {
        ok: false,
        status: status === "reversed" ? "cant_undo_dependent" : "nothing_to_redo",
        journalIds,
      };
    }
    throw cause;
  } finally {
    liveDoc.destroy();
    peer?.destroy();
    branchDoc.destroy();
  }
}

async function loadLiveDoc(
  journal: Pick<UpdateJournal, "read">,
  documentId: string,
): Promise<Y.Doc> {
  const snapshot = await journal.read(documentId);
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
