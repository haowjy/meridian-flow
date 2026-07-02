// Authoritative cold-path undo/redo reconstruction from the persisted Yjs journal.
import * as Y from "yjs";

import { PROSEMIRROR_FRAGMENT_NAME } from "../model/prosemirror-fragment.js";
import type { JournalSnapshot, PersistedUpdate } from "../ports/types.js";
import type { ReversalStore } from "../ports/update-journal.js";
import { shouldDeleteUndoItem, type UndoStackItemLike } from "./delete-filter.js";

export interface ReconstructionOptions {
  fragmentName?: string;
  /** Yjs clientID used for the local reconstructed undo/redo mutation. */
  undoClientId?: number;
}

interface ReconstructionTargetOptions extends ReconstructionOptions {
  targetSeqs: ReadonlySet<number>;
}

interface TargetUpdateGroup {
  targetId: string;
  updates: PersistedUpdate[];
  firstSeq: number;
  lastSeq: number;
}

interface CurrentUndoStackItem {
  value: UndoStackItemLike | null;
}

export interface UndoReconstructionResult {
  docId: string;
  turnId: string;
  undoUpdate: Uint8Array;
  /** State vector of the journal-replayed document immediately before undo. */
  endStateVector: Uint8Array;
}

export type RedoReconstructionResult =
  | RedoReconstructionAppliedResult
  | RedoReconstructionNoRedoResult;

export interface RedoReconstructionAppliedResult {
  ok: true;
  status: "redone";
  docId: string;
  turnId: string;
  redoUpdate: Uint8Array;
  undoUpdateSeq: number;
}

export interface RedoReconstructionNoRedoResult {
  ok: false;
  status: "no_redo";
  docId: string;
  turnId: string;
  undoUpdateSeq: number;
  reason: "forward_update_after_undo" | "empty_redo_stack";
  blockingUpdateSeq?: number;
  blockingUpdateOrigin?: string;
  blockingUpdateActorTurnId?: string;
}

export type RedoEligibility =
  | { ok: true }
  | {
      ok: false;
      status: "no_redo";
      reason: "forward_update_after_undo";
      blockingUpdateSeq: number;
      blockingUpdateOrigin: string;
      blockingUpdateActorTurnId?: string;
    };

export async function reconstructUndoUpdate(
  reversalStore: ReversalStore,
  docId: string,
  targetId: string,
  options: ReconstructionTargetOptions,
): Promise<UndoReconstructionResult> {
  const snapshot = await reversalStore.readForReconstruction(docId);
  return reconstructUndoUpdateFromSnapshot(snapshot, { ...options, docId, targetId });
}

export function reconstructUndoUpdateFromSnapshot(
  snapshot: JournalSnapshot,
  options: ReconstructionTargetOptions & { docId: string; targetId?: string; turnId?: string },
): UndoReconstructionResult {
  const targetId = options.targetId ?? options.turnId ?? "target";
  const target = targetUpdateRange(snapshot.updates, targetId, options.targetSeqs);
  const currentStackItem: CurrentUndoStackItem = { value: null };
  const { doc, um } = buildReplayedDocWithUndoManager(snapshot, target, {
    ...options,
    currentStackItem,
  });

  for (const update of snapshot.updates) {
    if (update.seq <= target.lastSeq) continue;
    replayNonTargetUpdate(doc, update);
  }

  setReconstructionClientId(doc, options.undoClientId);
  const beforeUndoStateVector = Y.encodeStateVector(doc);
  undoAllTrackedStackItems(um, currentStackItem);
  const undoUpdate = Y.encodeStateAsUpdate(doc, beforeUndoStateVector);
  return {
    docId: options.docId,
    turnId: targetId,
    undoUpdate,
    endStateVector: beforeUndoStateVector,
  };
}

export async function reconstructRedoUpdate(
  reversalStore: ReversalStore,
  docId: string,
  targetId: string,
  undoUpdateSeq: number,
  options: ReconstructionTargetOptions,
): Promise<RedoReconstructionResult> {
  const snapshot = await reversalStore.readForReconstruction(docId);
  return reconstructRedoUpdateFromSnapshot(snapshot, {
    ...options,
    docId,
    targetId,
    undoUpdateSeq,
  });
}

export function reconstructRedoUpdateFromSnapshot(
  snapshot: JournalSnapshot,
  options: ReconstructionTargetOptions & {
    docId: string;
    targetId?: string;
    turnId?: string;
    undoUpdateSeq: number;
  },
): RedoReconstructionResult {
  const targetId = options.targetId ?? options.turnId ?? "target";
  const target = targetUpdateRange(snapshot.updates, targetId, options.targetSeqs);
  const undoUpdate = snapshot.updates.find((update) => update.seq === options.undoUpdateSeq);
  if (!undoUpdate) throw new Error(`Undo update seq ${options.undoUpdateSeq} not found`);
  if (undoUpdate.seq <= target.lastSeq) {
    throw new Error(`Undo update seq ${options.undoUpdateSeq} must be after target ${targetId}`);
  }
  const eligibility = evaluateRedoEligibility(snapshot.updates, {
    undoUpdateSeq: undoUpdate.seq,
  });
  if (!eligibility.ok) return noRedoResult(options, eligibility);

  const currentStackItem: CurrentUndoStackItem = { value: null };
  const { doc, um } = buildReplayedDocWithUndoManager(snapshot, target, {
    ...options,
    currentStackItem,
  });

  for (const update of snapshot.updates) {
    if (update.seq <= target.lastSeq || update.seq >= undoUpdate.seq) continue;
    replayNonTargetUpdate(doc, update);
  }

  setReconstructionClientId(doc, options.undoClientId);
  currentStackItem.value = um.undoStack.at(-1) ?? null;
  try {
    um.undo();
  } finally {
    currentStackItem.value = null;
    um.stopCapturing();
  }

  for (const update of snapshot.updates) {
    if (update.seq <= undoUpdate.seq) continue;
    replayNonTargetUpdate(doc, update);
  }

  const beforeRedoStateVector = Y.encodeStateVector(doc);
  if (um.redoStack.length === 0) {
    return noRedoResult(options, { ok: false, status: "no_redo", reason: "empty_redo_stack" });
  }
  currentStackItem.value = um.redoStack.at(-1) ?? null;
  let popped: UndoStackItemLike | null;
  try {
    popped = um.redo();
  } finally {
    currentStackItem.value = null;
    um.stopCapturing();
  }
  if (!popped) {
    return noRedoResult(options, { ok: false, status: "no_redo", reason: "empty_redo_stack" });
  }
  const redoUpdate = Y.encodeStateAsUpdate(doc, beforeRedoStateVector);
  return {
    ok: true,
    status: "redone",
    docId: options.docId,
    turnId: targetId,
    redoUpdate,
    undoUpdateSeq: options.undoUpdateSeq,
  };
}

export function evaluateRedoEligibility(
  updates: readonly PersistedUpdate[],
  options: { undoUpdateSeq: number },
): RedoEligibility {
  const blockingUpdate = updates.find(
    (update) => update.seq > options.undoUpdateSeq && isForwardUpdate(update),
  );
  if (!blockingUpdate) return { ok: true };
  return {
    ok: false,
    status: "no_redo",
    reason: "forward_update_after_undo",
    blockingUpdateSeq: blockingUpdate.seq,
    blockingUpdateOrigin: blockingUpdate.meta.origin,
    blockingUpdateActorTurnId: blockingUpdate.meta.actorTurnId,
  };
}

function targetUpdateRange(
  updates: readonly PersistedUpdate[],
  targetId: string,
  targetSeqs: ReadonlySet<number>,
): TargetUpdateGroup {
  if (targetSeqs.size === 0) throw new Error(`No target update seqs provided for ${targetId}`);

  const missing = new Set(targetSeqs);
  const targetUpdates: PersistedUpdate[] = [];
  for (const update of updates) {
    if (!targetSeqs.has(update.seq)) continue;
    targetUpdates.push(update);
    missing.delete(update.seq);
  }
  if (missing.size > 0) {
    throw new Error(
      `Missing target update seqs for ${targetId}: ${[...missing].sort((a, b) => a - b).join(", ")}`,
    );
  }

  return {
    targetId,
    updates: targetUpdates,
    firstSeq: Math.min(...targetUpdates.map((update) => update.seq)),
    lastSeq: Math.max(...targetUpdates.map((update) => update.seq)),
  };
}

function buildReplayedDocWithUndoManager(
  snapshot: JournalSnapshot,
  target: TargetUpdateGroup,
  options: ReconstructionTargetOptions & { currentStackItem: CurrentUndoStackItem },
): { doc: Y.Doc; um: Y.UndoManager } {
  const doc = buildDocThroughUpdates(snapshot.checkpoint, snapshot.updates, {
    untilSeqExclusive: target.firstSeq,
  });
  const fragment = doc.getXmlFragment(options.fragmentName ?? PROSEMIRROR_FRAGMENT_NAME);
  const targetOriginToken = Symbol(`target-${target.targetId}`);
  const nonTargetOriginToken = Symbol("non-target");
  const um = new Y.UndoManager(fragment, {
    trackedOrigins: new Set([targetOriginToken]),
    captureTimeout: Number.POSITIVE_INFINITY,
    deleteFilter: (item) => shouldDeleteUndoItem(item, options.currentStackItem.value),
  });

  um.stopCapturing();
  for (const update of snapshot.updates) {
    if (update.seq < target.firstSeq) continue;
    if (update.seq > target.lastSeq) break;
    replayUpdateWithOrigin(
      doc,
      update,
      options.targetSeqs.has(update.seq) ? targetOriginToken : nonTargetOriginToken,
    );
  }
  um.stopCapturing();

  return { doc, um };
}

function buildDocThroughUpdates(
  checkpoint: Uint8Array | null,
  updates: readonly PersistedUpdate[],
  options: { untilSeqExclusive: number },
): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  if (checkpoint) Y.applyUpdate(doc, checkpoint);
  for (const update of updates) {
    if (update.seq >= options.untilSeqExclusive) break;
    Y.applyUpdate(doc, update.update);
  }
  return doc;
}

function undoAllTrackedStackItems(um: Y.UndoManager, currentStackItem: CurrentUndoStackItem): void {
  while (um.undoStack.length > 0) {
    currentStackItem.value = um.undoStack.at(-1) ?? null;
    try {
      um.undo();
    } finally {
      currentStackItem.value = null;
      um.stopCapturing();
    }
  }
}

function setReconstructionClientId(doc: Y.Doc, clientId: number | undefined): void {
  if (clientId === undefined || doc.clientID === clientId) return;
  doc.clientID = clientId;
}

function replayNonTargetUpdate(doc: Y.Doc, update: PersistedUpdate): void {
  replayUpdateWithOrigin(doc, update, Symbol("non-target"));
}

function replayUpdateWithOrigin(doc: Y.Doc, update: PersistedUpdate, origin: symbol): void {
  doc.transact(() => {
    Y.applyUpdate(doc, update.update);
  }, origin);
}

function noRedoResult(
  options: { docId: string; targetId?: string; turnId?: string; undoUpdateSeq: number },
  failure:
    | Exclude<RedoEligibility, { ok: true }>
    | { ok: false; status: "no_redo"; reason: "empty_redo_stack" },
): RedoReconstructionNoRedoResult {
  return {
    ok: false,
    status: "no_redo",
    docId: options.docId,
    turnId: options.targetId ?? options.turnId ?? "target",
    undoUpdateSeq: options.undoUpdateSeq,
    reason: failure.reason,
    blockingUpdateSeq:
      failure.reason === "forward_update_after_undo" ? failure.blockingUpdateSeq : undefined,
    blockingUpdateOrigin:
      failure.reason === "forward_update_after_undo" ? failure.blockingUpdateOrigin : undefined,
    blockingUpdateActorTurnId:
      failure.reason === "forward_update_after_undo"
        ? failure.blockingUpdateActorTurnId
        : undefined,
  };
}

function isForwardUpdate(update: PersistedUpdate): boolean {
  return update.meta.actorTurnId !== undefined || isForwardOrigin(update.meta.origin);
}

function isForwardOrigin(origin: string): boolean {
  return origin.startsWith("agent:") || origin.startsWith("human:");
}
