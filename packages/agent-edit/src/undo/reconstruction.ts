// Authoritative cold-path undo/redo reconstruction from the persisted Yjs journal.
import * as Y from "yjs";

import { PROSEMIRROR_FRAGMENT_NAME } from "../model/prosemirror-fragment.js";
import type { JournalSnapshot, PersistedUpdate } from "../ports/types.js";
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

// Historical draft rows could mark destructive whole-document updates. The
// producer is gone; this optional field exists only while replaying old rows.
type HistoricalReplayUpdate = PersistedUpdate & { updateKind?: string | null };

export interface UndoReconstructionResult {
  docId: string;
  turnId: string;
  undoUpdate: Uint8Array;
  /** State vector of the journal-replayed document immediately before undo. */
  endStateVector: Uint8Array;
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

export function evaluateRedoEligibility(
  updates: readonly PersistedUpdate[],
  options: { undoUpdateSeq: number },
): RedoEligibility {
  const blockingUpdate = updates.find(
    (update) => update.seq > options.undoUpdateSeq && isWriterUpdate(update),
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
    fragmentName: options.fragmentName,
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
      options.fragmentName,
    );
  }
  um.stopCapturing();

  return { doc, um };
}

function buildDocThroughUpdates(
  checkpoint: Uint8Array | null,
  updates: readonly PersistedUpdate[],
  options: { untilSeqExclusive: number; fragmentName?: string },
): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  if (checkpoint) Y.applyUpdate(doc, checkpoint);
  for (const update of updates) {
    if (update.seq >= options.untilSeqExclusive) break;
    replayHistoricalUpdate(doc, update, { fragmentName: options.fragmentName });
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

function replayUpdateWithOrigin(
  doc: Y.Doc,
  update: PersistedUpdate,
  origin: symbol,
  fragmentName = PROSEMIRROR_FRAGMENT_NAME,
): void {
  replayHistoricalUpdate(doc, update, { fragmentName, origin });
}

function replayHistoricalUpdate(
  doc: Y.Doc,
  update: HistoricalReplayUpdate,
  options: { fragmentName?: string; origin?: unknown } = {},
): void {
  if (update.updateKind !== "replaceAll") {
    Y.applyUpdate(doc, update.update, options.origin);
    return;
  }

  doc.transact(() => {
    const fragment = doc.getXmlFragment(options.fragmentName ?? PROSEMIRROR_FRAGMENT_NAME);
    fragment.delete(0, fragment.length);
    Y.applyUpdate(doc, update.update, options.origin);
  }, options.origin);
}

function isWriterUpdate(update: PersistedUpdate): boolean {
  return update.meta.origin.startsWith("human:");
}
