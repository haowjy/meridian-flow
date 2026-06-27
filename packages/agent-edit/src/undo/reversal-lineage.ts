// Durable reversal lineage helpers: derive ownership from mutation and reversal rows, never delete-set guesses.
import * as Y from "yjs";

import type { JournalSnapshot, PersistedUpdate, ReversalRecord } from "../ports/types.js";
import type { WriteMutationRow } from "../ports/update-journal.js";

interface LineageHandleState {
  handle: string;
  forwardSeqs: number[];
  undoSeqs: number[];
  redoSeqs: number[];
  activeRedoSeq?: number;
  activeBoundary: string;
}

interface ActiveClosure {
  handles: string[];
  forwardSeqs: ReadonlySet<number>;
  targetSeqs: ReadonlySet<number>;
  lineageSeqs: ReadonlySet<number>;
  earliestForwardSeq: number;
}

interface CompatibleLineageGroup extends ActiveClosure {
  boundary: string;
}

type DependencyVerdict = { ok: true } | { ok: false; blockingWriteIds: readonly string[] };

interface IdRange {
  client: number;
  clock: number;
  len: number;
}

interface DecodedUpdateLike {
  structs?: readonly { id?: { client: number; clock: number }; length?: number }[];
  ds?: { clients?: Map<number, readonly { clock: number; len: number }[]> };
}

export type UndoClosure =
  | { ok: true; handles: string[]; targetSeqs: ReadonlySet<number> }
  | { ok: false; status: "nothing_to_undo" }
  | {
      ok: false;
      status: "cant_undo_dependent";
      blockingWriteIds: string[];
      selectedWriteIds: string[];
    };

export function selectUndoClosure(input: {
  snapshot: JournalSnapshot;
  reversals: readonly ReversalRecord[];
  /** All candidate handles' mutation rows, UNFILTERED (status + retention handled inside). */
  rowsByHandle: ReadonlyMap<string, readonly WriteMutationRow[]>;
  /** Handles chosen by the active-write selection. */
  selectedHandles: readonly string[];
  /** All handles present in state — the expansion pool. */
  candidateHandles: readonly string[];
  reversalOpSeqs: ReadonlySet<number>;
  isScopeSelection: boolean;
}): UndoClosure {
  const retained = retainedActiveRowsForHandles({
    handles: input.candidateHandles,
    rowsByHandle: input.rowsByHandle,
    snapshot: input.snapshot,
  });
  const retainedSelected = input.selectedHandles.filter((handle) =>
    retained.writeIds.includes(handle),
  );
  if (retainedSelected.length === 0) return { ok: false, status: "nothing_to_undo" };

  const seedHandles = input.isScopeSelection
    ? (compatibleLineageGroups({
        handles: retainedSelected,
        rowsByHandle: retained.rowsByHandle,
        reversals: input.reversals,
      })[0]?.handles ?? [])
    : retainedSelected;

  const closure = expandActiveClosureToCompatibleBoundary({
    selectedHandles: seedHandles,
    candidateHandles: retained.writeIds,
    rowsByHandle: retained.rowsByHandle,
    reversals: input.reversals,
  });
  if (!closure || closure.targetSeqs.size === 0) return { ok: false, status: "nothing_to_undo" };

  if (![...closure.targetSeqs].every((seq) => snapshotRetainsSeq(input.snapshot, seq))) {
    return { ok: false, status: "nothing_to_undo" };
  }

  const dependency = evaluateLineageDependencies({
    snapshot: input.snapshot,
    closure,
    reversalOpSeqs: input.reversalOpSeqs,
    seqToHandle: seqToHandleFromMutations(input.rowsByHandle, input.reversals),
  });
  if (!dependency.ok) {
    return {
      ok: false,
      status: "cant_undo_dependent",
      blockingWriteIds: [...dependency.blockingWriteIds],
      selectedWriteIds: closure.handles,
    };
  }

  return { ok: true, handles: closure.handles, targetSeqs: closure.targetSeqs };
}

function activeClosureForHandles(input: {
  handles: readonly string[];
  rowsByHandle: ReadonlyMap<string, readonly WriteMutationRow[]>;
  reversals: readonly ReversalRecord[];
}): ActiveClosure | undefined {
  const states = lineageStatesForHandles(input);
  const forwardSeqs = new Set<number>();
  const targetSeqs = new Set<number>();
  const lineageSeqs = new Set<number>();
  const handles: string[] = [];

  for (const state of states) {
    if (state.forwardSeqs.length === 0) continue;
    handles.push(state.handle);
    for (const seq of state.forwardSeqs) {
      forwardSeqs.add(seq);
      lineageSeqs.add(seq);
    }
    for (const seq of state.undoSeqs) lineageSeqs.add(seq);
    for (const seq of state.redoSeqs) lineageSeqs.add(seq);
    if (state.activeRedoSeq !== undefined) {
      targetSeqs.add(state.activeRedoSeq);
    } else {
      for (const seq of state.forwardSeqs) targetSeqs.add(seq);
    }
  }

  if (handles.length === 0 || forwardSeqs.size === 0) return undefined;
  return {
    handles,
    forwardSeqs,
    targetSeqs,
    lineageSeqs,
    earliestForwardSeq: Math.min(...forwardSeqs),
  };
}

function expandActiveClosureToCompatibleBoundary(input: {
  selectedHandles: readonly string[];
  candidateHandles: readonly string[];
  rowsByHandle: ReadonlyMap<string, readonly WriteMutationRow[]>;
  reversals: readonly ReversalRecord[];
}): ActiveClosure | undefined {
  const states = lineageStatesForHandles({
    handles: input.candidateHandles,
    rowsByHandle: input.rowsByHandle,
    reversals: input.reversals,
  });
  const statesByHandle = new Map(states.map((state) => [state.handle, state]));
  const selected = new Set(input.selectedHandles);
  const boundarySeqs = new Set<number>();

  for (const handle of selected) {
    const state = statesByHandle.get(handle);
    if (state?.activeRedoSeq !== undefined) boundarySeqs.add(state.activeRedoSeq);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const state of states) {
      if (state.activeRedoSeq === undefined || !boundarySeqs.has(state.activeRedoSeq)) continue;
      if (!selected.has(state.handle)) {
        selected.add(state.handle);
        changed = true;
      }
    }
  }

  const handles = sortWriteHandles([...selected]);
  const closure = activeClosureForHandles({
    handles,
    rowsByHandle: input.rowsByHandle,
    reversals: input.reversals,
  });
  return closure;
}

function compatibleLineageGroups(input: {
  handles: readonly string[];
  rowsByHandle: ReadonlyMap<string, readonly WriteMutationRow[]>;
  reversals: readonly ReversalRecord[];
}): CompatibleLineageGroup[] {
  const states = lineageStatesForHandles(input);
  const byBoundary = new Map<string, string[]>();
  for (const state of states) {
    if (state.forwardSeqs.length === 0) continue;
    const group = byBoundary.get(state.activeBoundary) ?? [];
    group.push(state.handle);
    byBoundary.set(state.activeBoundary, group);
  }

  return [...byBoundary.entries()]
    .map(([boundary, handles]) => {
      const closure = activeClosureForHandles({ ...input, handles });
      if (!closure) return undefined;
      return { ...closure, boundary };
    })
    .filter((group): group is CompatibleLineageGroup => group !== undefined)
    .sort((left, right) => left.earliestForwardSeq - right.earliestForwardSeq);
}

function evaluateLineageDependencies(input: {
  snapshot: JournalSnapshot;
  closure: ActiveClosure;
  seqToHandle?: ReadonlyMap<number, string>;
  reversalOpSeqs?: ReadonlySet<number>;
}): DependencyVerdict {
  const selectedInsertedIds = insertedIdRanges(
    input.snapshot.updates.filter(
      (update) =>
        input.closure.targetSeqs.has(update.seq) || input.closure.forwardSeqs.has(update.seq),
    ),
  );
  if (selectedInsertedIds.length === 0) return { ok: true };

  const selectedHandles = new Set(input.closure.handles);
  const blockingWriteIds = new Set<string>();
  let hasUnknownBlocker = false;

  for (const update of input.snapshot.updates) {
    if (update.seq <= input.closure.earliestForwardSeq) continue;
    if (input.closure.lineageSeqs.has(update.seq) || input.reversalOpSeqs?.has(update.seq))
      continue;
    if (!deleteSetIntersects(update, selectedInsertedIds)) continue;
    const handle = input.seqToHandle?.get(update.seq);
    if (handle && !selectedHandles.has(handle)) blockingWriteIds.add(handle);
    else hasUnknownBlocker = true;
  }

  if (blockingWriteIds.size === 0 && !hasUnknownBlocker) return { ok: true };
  return {
    ok: false,
    blockingWriteIds: sortWriteHandles([
      ...blockingWriteIds,
      ...(hasUnknownBlocker ? ["a later edit"] : []),
    ]),
  };
}

function seqToHandleFromMutations(
  rowsByHandle: ReadonlyMap<string, readonly WriteMutationRow[]>,
  reversals: readonly ReversalRecord[],
): Map<number, string> {
  const seqToHandle = new Map<number, string>();
  for (const [handle, rows] of rowsByHandle) {
    for (const row of rows) seqToHandle.set(row.createdSeq, handle);
  }
  for (const reversal of reversals) {
    for (const handle of reversal.writeIds) {
      seqToHandle.set(reversal.undoUpdateSeq, handle);
      if (reversal.redoUpdateSeq !== undefined) seqToHandle.set(reversal.redoUpdateSeq, handle);
    }
  }
  return seqToHandle;
}

function lineageStatesForHandles(input: {
  handles: readonly string[];
  rowsByHandle: ReadonlyMap<string, readonly WriteMutationRow[]>;
  reversals: readonly ReversalRecord[];
}): LineageHandleState[] {
  return input.handles.map((handle) => {
    const forwardSeqs = [...(input.rowsByHandle.get(handle) ?? [])]
      .map((row) => row.createdSeq)
      .sort((left, right) => left - right);
    const reversals = input.reversals.filter((record) => record.writeIds.includes(handle));
    const undoSeqs = reversals.map((record) => record.undoUpdateSeq);
    const redoSeqs = reversals.flatMap((record) =>
      record.redoUpdateSeq === undefined ? [] : [record.redoUpdateSeq],
    );
    const activeRedoSeq = reversals.find(
      (record) => record.status === "redone" && record.redoUpdateSeq !== undefined,
    )?.redoUpdateSeq;
    return {
      handle,
      forwardSeqs,
      undoSeqs,
      redoSeqs,
      activeRedoSeq,
      activeBoundary: activeRedoSeq === undefined ? "forward" : `redo:${activeRedoSeq}`,
    };
  });
}

function retainedActiveRowsForHandles(input: {
  handles: readonly string[];
  rowsByHandle: ReadonlyMap<string, readonly WriteMutationRow[]>;
  snapshot: JournalSnapshot;
}): { writeIds: string[]; rowsByHandle: Map<string, WriteMutationRow[]> } {
  const retainedSeqs = new Set(input.snapshot.updates.map((update) => update.seq));
  const retained: { handle: string; rows: WriteMutationRow[] }[] = [];
  for (const handle of input.handles) {
    const rows = (input.rowsByHandle.get(handle) ?? []).filter((row) => row.status === "active");
    if (rows.length > 0 && rows.every((row) => retainedSeqs.has(row.createdSeq))) {
      retained.push({ handle, rows });
    }
  }
  return {
    writeIds: retained.map(({ handle }) => handle),
    rowsByHandle: new Map(retained.map(({ handle, rows }) => [handle, rows])),
  };
}

function snapshotRetainsSeq(snapshot: { updates: { seq: number }[] }, seq: number): boolean {
  return snapshot.updates.some((update) => update.seq === seq);
}

function insertedIdRanges(updates: readonly PersistedUpdate[]): IdRange[] {
  const ranges: IdRange[] = [];
  for (const update of updates) {
    const decoded = decodeUpdate(update);
    if (!decoded) continue;
    for (const struct of decoded.structs ?? []) {
      const id = struct.id;
      const len = struct.length ?? 0;
      if (!id || len <= 0) continue;
      ranges.push({ client: id.client, clock: id.clock, len });
    }
  }
  return ranges;
}

function deleteSetIntersects(update: PersistedUpdate, insertedRanges: readonly IdRange[]): boolean {
  const decoded = decodeUpdate(update);
  const deleteClients = decoded?.ds?.clients;
  if (!deleteClients || deleteClients.size === 0) return false;
  for (const inserted of insertedRanges) {
    const deletes = deleteClients.get(inserted.client) ?? [];
    for (const deleted of deletes) {
      if (rangesIntersect(inserted.clock, inserted.len, deleted.clock, deleted.len)) return true;
    }
  }
  return false;
}

function decodeUpdate(update: PersistedUpdate): DecodedUpdateLike | undefined {
  try {
    return Y.decodeUpdate(update.update) as DecodedUpdateLike;
  } catch {
    return undefined;
  }
}

function rangesIntersect(leftClock: number, leftLen: number, rightClock: number, rightLen: number) {
  return leftClock < rightClock + rightLen && rightClock < leftClock + leftLen;
}

function sortWriteHandles(handles: readonly string[]): string[] {
  return [...handles].sort((left, right) => {
    const leftOrdinal = parseOrdinal(left);
    const rightOrdinal = parseOrdinal(right);
    if (leftOrdinal !== undefined && rightOrdinal !== undefined) return leftOrdinal - rightOrdinal;
    if (leftOrdinal !== undefined) return -1;
    if (rightOrdinal !== undefined) return 1;
    return left.localeCompare(right);
  });
}

function parseOrdinal(handle: string): number | undefined {
  if (!/^w[1-9]\d*$/.test(handle)) return undefined;
  const ordinal = Number(handle.slice(1));
  return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}
