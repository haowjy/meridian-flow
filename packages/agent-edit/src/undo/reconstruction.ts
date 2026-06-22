// Authoritative cold-path undo/redo reconstruction from the persisted Yjs journal.
import * as Y from "yjs";

import { PROSEMIRROR_FRAGMENT_NAME } from "../model/prosemirror-fragment.js";
import type { JournalSnapshot, PersistedUpdate } from "../ports/types.js";
import type { UpdateJournal } from "../ports/update-journal.js";
import { shouldDeleteUndoItem, type UndoStackItemLike } from "./delete-filter.js";

export interface ReconstructionOptions {
  fragmentName?: string;
  /** Yjs clientID used for the local reconstructed undo/redo mutation; match hot mutationClientId for byte parity. */
  undoClientId?: number;
}

export interface TurnUpdateGroup {
  turnId: string;
  updates: PersistedUpdate[];
  firstSeq: number;
  lastSeq: number;
}

export interface UndoReconstructionResult {
  docId: string;
  turnId: string;
  undoUpdate: Uint8Array;
  targetUpdateSeqs: number[];
  beforeUndoStateVector: Uint8Array;
  afterUndoStateVector: Uint8Array;
  undoStackDepthBeforeUndo: number;
  redoStackDepthAfterUndo: number;
  /** Exposed for tests to assert fresh per-reconstruction identity tokens. */
  targetOriginToken: symbol;
  nonTargetOriginToken: symbol;
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
  targetUpdateSeqs: number[];
  beforeRedoStateVector: Uint8Array;
  afterRedoStateVector: Uint8Array;
  redoStackDepthBeforeRedo: number;
  undoStackDepthAfterRedo: number;
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
  journal: UpdateJournal,
  docId: string,
  turnId: string,
  options: ReconstructionOptions = {},
): Promise<UndoReconstructionResult> {
  const snapshot = await journal.read(docId);
  return reconstructUndoUpdateFromSnapshot(snapshot, { ...options, docId, turnId });
}

export function reconstructUndoUpdateFromSnapshot(
  snapshot: JournalSnapshot,
  options: ReconstructionOptions & { docId: string; turnId: string },
): UndoReconstructionResult {
  const target = targetTurnRange(snapshot.updates, options.turnId);
  const doc = buildDocThroughUpdates(snapshot.checkpoint, snapshot.updates, {
    untilSeqExclusive: target.firstSeq,
    clientId: options.undoClientId,
  });
  const fragment = doc.getXmlFragment(options.fragmentName ?? PROSEMIRROR_FRAGMENT_NAME);
  const targetOriginToken = Symbol(`turn-${options.turnId}`);
  const nonTargetOriginToken = Symbol("non-target");
  let currentStackItem: UndoStackItemLike | null = null;
  const um = new Y.UndoManager(fragment, {
    trackedOrigins: new Set([targetOriginToken]),
    captureTimeout: Number.POSITIVE_INFINITY,
    deleteFilter: (item) => shouldDeleteUndoItem(item, currentStackItem),
  });

  um.stopCapturing();
  for (const update of snapshot.updates) {
    if (update.seq < target.firstSeq) continue;
    if (update.seq > target.lastSeq) break;
    replayUpdateWithOrigin(
      doc,
      update,
      update.meta.actorTurnId === options.turnId ? targetOriginToken : nonTargetOriginToken,
    );
  }
  um.stopCapturing();

  for (const update of snapshot.updates) {
    if (update.seq <= target.lastSeq) continue;
    replayUpdateWithOrigin(doc, update, nonTargetOriginToken);
  }

  const beforeUndoStateVector = Y.encodeStateVector(doc);
  const undoStackDepthBeforeUndo = um.undoStack.length;
  currentStackItem = um.undoStack.at(-1) ?? null;
  try {
    um.undo();
  } finally {
    currentStackItem = null;
    um.stopCapturing();
  }
  const undoUpdate = Y.encodeStateAsUpdate(doc, beforeUndoStateVector);
  return {
    docId: options.docId,
    turnId: options.turnId,
    undoUpdate,
    targetUpdateSeqs: target.updates.map((update) => update.seq),
    beforeUndoStateVector,
    afterUndoStateVector: Y.encodeStateVector(doc),
    undoStackDepthBeforeUndo,
    redoStackDepthAfterUndo: um.redoStack.length,
    targetOriginToken,
    nonTargetOriginToken,
  };
}

export async function reconstructRedoUpdate(
  journal: UpdateJournal,
  docId: string,
  turnId: string,
  undoUpdateSeq: number,
  options: ReconstructionOptions = {},
): Promise<RedoReconstructionResult> {
  const snapshot = await journal.read(docId);
  return reconstructRedoUpdateFromSnapshot(snapshot, { ...options, docId, turnId, undoUpdateSeq });
}

export function reconstructRedoUpdateFromSnapshot(
  snapshot: JournalSnapshot,
  options: ReconstructionOptions & { docId: string; turnId: string; undoUpdateSeq: number },
): RedoReconstructionResult {
  const target = targetTurnRange(snapshot.updates, options.turnId);
  const undoUpdate = snapshot.updates.find((update) => update.seq === options.undoUpdateSeq);
  if (!undoUpdate) throw new Error(`Undo update seq ${options.undoUpdateSeq} not found`);
  if (undoUpdate.seq <= target.lastSeq) {
    throw new Error(
      `Undo update seq ${options.undoUpdateSeq} must be after target turn ${options.turnId}`,
    );
  }
  const eligibility = evaluateRedoEligibility(snapshot.updates, {
    undoUpdateSeq: undoUpdate.seq,
  });
  if (!eligibility.ok) return noRedoResult(options, eligibility);

  const doc = buildDocThroughUpdates(snapshot.checkpoint, snapshot.updates, {
    untilSeqExclusive: target.firstSeq,
    clientId: options.undoClientId,
  });
  const fragment = doc.getXmlFragment(options.fragmentName ?? PROSEMIRROR_FRAGMENT_NAME);
  const targetOriginToken = Symbol(`turn-${options.turnId}`);
  const nonTargetOriginToken = Symbol("non-target");
  let currentStackItem: UndoStackItemLike | null = null;
  const um = new Y.UndoManager(fragment, {
    trackedOrigins: new Set([targetOriginToken]),
    captureTimeout: Number.POSITIVE_INFINITY,
    deleteFilter: (item) => shouldDeleteUndoItem(item, currentStackItem),
  });

  um.stopCapturing();
  for (const update of snapshot.updates) {
    if (update.seq < target.firstSeq) continue;
    if (update.seq > target.lastSeq) break;
    replayUpdateWithOrigin(
      doc,
      update,
      update.meta.actorTurnId === options.turnId ? targetOriginToken : nonTargetOriginToken,
    );
  }
  um.stopCapturing();

  for (const update of snapshot.updates) {
    if (update.seq <= target.lastSeq || update.seq >= undoUpdate.seq) continue;
    replayUpdateWithOrigin(doc, update, nonTargetOriginToken);
  }

  currentStackItem = um.undoStack.at(-1) ?? null;
  try {
    um.undo();
  } finally {
    currentStackItem = null;
    um.stopCapturing();
  }

  for (const update of snapshot.updates) {
    if (update.seq <= undoUpdate.seq) continue;
    replayUpdateWithOrigin(doc, update, nonTargetOriginToken);
  }

  const beforeRedoStateVector = Y.encodeStateVector(doc);
  const redoStackDepthBeforeRedo = um.redoStack.length;
  if (redoStackDepthBeforeRedo === 0) {
    return noRedoResult(options, { ok: false, status: "no_redo", reason: "empty_redo_stack" });
  }
  currentStackItem = um.redoStack.at(-1) ?? null;
  let popped: UndoStackItemLike | null;
  try {
    popped = um.redo();
  } finally {
    currentStackItem = null;
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
    turnId: options.turnId,
    redoUpdate,
    undoUpdateSeq: options.undoUpdateSeq,
    targetUpdateSeqs: target.updates.map((update) => update.seq),
    beforeRedoStateVector,
    afterRedoStateVector: Y.encodeStateVector(doc),
    redoStackDepthBeforeRedo,
    undoStackDepthAfterRedo: um.undoStack.length,
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

export function groupUpdatesByTurn(updates: readonly PersistedUpdate[]): TurnUpdateGroup[] {
  const byTurn = new Map<string, PersistedUpdate[]>();
  for (const update of updates) {
    const turnId = update.meta.actorTurnId;
    if (!turnId) continue;
    const group = byTurn.get(turnId) ?? [];
    group.push(update);
    byTurn.set(turnId, group);
  }
  return [...byTurn.entries()]
    .map(([turnId, group]) => ({
      turnId,
      updates: group,
      firstSeq: Math.min(...group.map((update) => update.seq)),
      lastSeq: Math.max(...group.map((update) => update.seq)),
    }))
    .sort((left, right) => left.firstSeq - right.firstSeq);
}

function targetTurnRange(updates: readonly PersistedUpdate[], turnId: string): TurnUpdateGroup {
  const target = groupUpdatesByTurn(updates).find((group) => group.turnId === turnId);
  if (!target) throw new Error(`No persisted updates found for turn ${turnId}`);
  return target;
}

function buildDocThroughUpdates(
  checkpoint: Uint8Array | null,
  updates: readonly PersistedUpdate[],
  options: { untilSeqExclusive: number; clientId?: number },
): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  if (checkpoint) Y.applyUpdate(doc, checkpoint);
  for (const update of updates) {
    if (update.seq >= options.untilSeqExclusive) break;
    Y.applyUpdate(doc, update.update);
  }
  setReconstructionClientId(doc, options.clientId);
  return doc;
}

function setReconstructionClientId(doc: Y.Doc, clientId: number | undefined): void {
  if (clientId === undefined || doc.clientID === clientId) return;
  const store = doc as unknown as { store?: { clients?: Map<number, unknown> } };
  if (store.store?.clients?.has(clientId)) {
    throw new Error(
      `Cannot use Yjs clientID ${clientId} for reconstruction; it already exists in the journal`,
    );
  }
  doc.clientID = clientId;
}

function replayUpdateWithOrigin(doc: Y.Doc, update: PersistedUpdate, origin: symbol): void {
  doc.transact(() => {
    Y.applyUpdate(doc, update.update);
  }, origin);
}

function noRedoResult(
  options: { docId: string; turnId: string; undoUpdateSeq: number },
  failure:
    | Exclude<RedoEligibility, { ok: true }>
    | { ok: false; status: "no_redo"; reason: "empty_redo_stack" },
): RedoReconstructionNoRedoResult {
  return {
    ok: false,
    status: "no_redo",
    docId: options.docId,
    turnId: options.turnId,
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
