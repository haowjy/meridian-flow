// Canonical write-level undo/redo planner: loads reversal state once and normalizes selection.
import type { JournalSnapshot } from "../ports/types.js";
import {
  type ActiveWriteSummary,
  parseWriteHandle,
  type ReversalStore,
  type WriteMutationRow,
} from "../ports/update-journal.js";
import { evaluateRedoEligibility } from "./reconstruction.js";

export type ReversalSelection =
  | { kind: "latest" }
  | { kind: "single"; to: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "last"; count: number }
  | { kind: "all" }
  | { kind: "turn"; turnId?: string };

export type ReversalPlanStatus =
  | "nothing_to_undo"
  | "nothing_to_redo"
  | "cant_undo_dependent"
  | "invalid_write";

export type ReversalPlan =
  | {
      ok: true;
      direction: "undo" | "redo";
      writeIds: string[];
      turnId: string;
      targetSeqs: ReadonlySet<number>;
      snapshot: JournalSnapshot;
      redoGroup?: { undoUpdateSeq: number };
    }
  | { ok: false; status: ReversalPlanStatus; message?: string; blockingWriteIds?: string[] };

export async function planUndo(input: {
  reversalStore: ReversalStore;
  docId: string;
  threadId: string;
  selection: ReversalSelection;
}): Promise<ReversalPlan> {
  const state = await loadState(input.reversalStore, input.docId, input.threadId);
  const selected = selectActiveWrites(state.activeWrites, input.selection);
  if (!selected.ok) return selected;
  if (selected.writes.length === 0) return { ok: false, status: "nothing_to_undo" };

  const retained = await retainedRowsForHandles(
    input.reversalStore,
    input.docId,
    input.threadId,
    selected.writeIds,
    state.snapshot,
    "active",
  );
  const targetSeqs = mutationSeqs(retained.rows);
  if (targetSeqs.size === 0) return { ok: false, status: "nothing_to_undo" };
  return {
    ok: true,
    direction: "undo",
    writeIds: retained.writeIds,
    turnId: retained.rows[0]?.turnId ?? "unknown",
    targetSeqs,
    snapshot: state.snapshot,
  };
}

export async function planRedo(input: {
  reversalStore: ReversalStore;
  docId: string;
  threadId: string;
  selection: ReversalSelection;
  now?: Date;
}): Promise<ReversalPlan> {
  const state = await loadState(input.reversalStore, input.docId, input.threadId);
  const groups = redoGroups(state, input.now ?? new Date());
  const selected = selectRedoGroup(groups, input.selection);
  if (!selected.ok) return selected;
  if (!selected.group) return { ok: false, status: "nothing_to_redo" };

  const group = selected.group;
  const retained = await retainedRowsForHandles(
    input.reversalStore,
    input.docId,
    input.threadId,
    group.writeIds,
    state.snapshot,
    "reversed",
    group.undoUpdateSeq,
  );
  if (retained.writeIds.length !== group.writeIds.length) {
    return { ok: false, status: "nothing_to_redo" };
  }
  const targetSeqs = mutationSeqs(retained.rows);
  if (targetSeqs.size === 0) return { ok: false, status: "nothing_to_redo" };
  if (!snapshotRetainsSeq(state.snapshot, group.undoUpdateSeq)) {
    return { ok: false, status: "nothing_to_redo" };
  }
  if (!evaluateRedoEligibility(state.snapshot.updates, { undoUpdateSeq: group.undoUpdateSeq }).ok) {
    return { ok: false, status: "nothing_to_redo" };
  }

  return {
    ok: true,
    direction: "redo",
    writeIds: group.writeIds,
    turnId: group.turnId,
    targetSeqs,
    snapshot: state.snapshot,
    redoGroup: { undoUpdateSeq: group.undoUpdateSeq },
  };
}

export function snapshotRetainsSeq(snapshot: { updates: { seq: number }[] }, seq: number): boolean {
  return snapshot.updates.some((update) => update.seq === seq);
}

async function loadState(reversalStore: ReversalStore, docId: string, threadId: string) {
  const [snapshot, activeWrites, reversals] = await Promise.all([
    reversalStore.readForReconstruction(docId),
    reversalStore.activeWriteSummary(docId, threadId),
    reversalStore.readReversals(docId, { threadId }),
  ]);
  return { snapshot, activeWrites, reversals };
}

async function retainedRowsForHandles(
  reversalStore: ReversalStore,
  docId: string,
  threadId: string,
  handles: readonly string[],
  snapshot: JournalSnapshot,
  status: WriteMutationRow["status"],
  undoUpdateSeq?: number,
): Promise<{ writeIds: string[]; rows: WriteMutationRow[] }> {
  const retainedSeqs = new Set(snapshot.updates.map((update) => update.seq));
  const rowsByHandle = await Promise.all(
    handles.map(async (handle) => ({
      handle,
      rows: (await reversalStore.mutationsForWrite(docId, threadId, handle)).filter(
        (row) =>
          row.status === status &&
          (undoUpdateSeq === undefined || row.undoUpdateSeq === undoUpdateSeq),
      ),
    })),
  );
  const retained = rowsByHandle.filter(
    ({ rows }) => rows.length > 0 && rows.every((row) => retainedSeqs.has(row.createdSeq)),
  );
  return {
    writeIds: retained.map(({ handle }) => handle),
    rows: retained.flatMap(({ rows }) => rows),
  };
}

function mutationSeqs(rows: readonly WriteMutationRow[]): ReadonlySet<number> {
  return new Set(rows.map((row) => row.createdSeq));
}

function selectActiveWrites(
  activeWrites: readonly ActiveWriteSummary[],
  selection: ReversalSelection,
):
  | { ok: true; writes: ActiveWriteSummary[]; writeIds: string[] }
  | { ok: false; status: "invalid_write"; message: string } {
  const selected = selectByHandle(activeWrites, selection);
  if (!selected.ok) return selected;
  return { ok: true, writes: selected.items, writeIds: selected.items.map((row) => row.handle) };
}

interface RedoGroup {
  writeIds: string[];
  turnId: string;
  undoUpdateSeq: number;
  reversedAt?: Date;
}

function redoGroups(state: Awaited<ReturnType<typeof loadState>>, now: Date): RedoGroup[] {
  const bySeq = new Map<number, RedoGroup>();
  for (const record of state.reversals) {
    if (record.status !== "reversed") continue;
    if (record.expiresAt && record.expiresAt <= now) continue;
    if (!snapshotRetainsSeq(state.snapshot, record.undoUpdateSeq)) continue;
    const group = bySeq.get(record.undoUpdateSeq) ?? {
      writeIds: [],
      turnId: record.turnId,
      undoUpdateSeq: record.undoUpdateSeq,
      reversedAt: record.reversedAt,
    };
    for (const writeId of record.writeIds)
      if (!group.writeIds.includes(writeId)) group.writeIds.push(writeId);
    bySeq.set(record.undoUpdateSeq, group);
  }
  return [...bySeq.values()]
    .map((group) => ({ ...group, writeIds: sortHandles(group.writeIds) }))
    .sort(
      (left, right) =>
        left.undoUpdateSeq - right.undoUpdateSeq ||
        (left.reversedAt?.getTime() ?? 0) - (right.reversedAt?.getTime() ?? 0),
    );
}

function selectRedoGroup(
  groups: readonly RedoGroup[],
  selection: ReversalSelection,
): { ok: true; group?: RedoGroup } | { ok: false; status: "invalid_write"; message: string } {
  if (selection.kind === "latest") return { ok: true, group: groups.at(-1) };
  if (selection.kind === "last") return { ok: true, group: groups.slice(-selection.count).at(0) };
  if (selection.kind === "all") return { ok: true, group: groups.at(0) };
  if (selection.kind === "turn") {
    const targetTurnId = selection.turnId ?? groups.at(-1)?.turnId;
    return { ok: true, group: groups.filter((group) => group.turnId === targetTurnId).at(-1) };
  }
  const selected = groups.filter((group) => handlesOverlapSelection(group.writeIds, selection));
  if (selection.kind === "single") return { ok: true, group: selected.at(-1) };
  return { ok: true, group: selected[0] };
}

function selectByHandle<T extends { handle: string; turnId: string; createdSeq: number }>(
  items: readonly T[],
  selection: ReversalSelection,
): { ok: true; items: T[] } | { ok: false; status: "invalid_write"; message: string } {
  if (selection.kind === "latest") return { ok: true, items: items.slice(-1) };
  if (selection.kind === "single")
    return { ok: true, items: items.filter((item) => item.handle === selection.to) };
  if (selection.kind === "all") return { ok: true, items: [...items] };
  if (selection.kind === "last") return { ok: true, items: items.slice(-selection.count) };
  if (selection.kind === "turn") {
    const targetTurnId = selection.turnId ?? latestByCreatedSeq(items)?.turnId;
    return { ok: true, items: items.filter((item) => item.turnId === targetTurnId) };
  }
  const from = parseWriteHandle(selection.from);
  const to = parseWriteHandle(selection.to);
  if (from === undefined || to === undefined || from > to) {
    return { ok: false, status: "invalid_write", message: "Invalid write range" };
  }
  return {
    ok: true,
    items: items.filter((item) => {
      const ordinal = parseWriteHandle(item.handle);
      return ordinal !== undefined && ordinal >= from && ordinal <= to;
    }),
  };
}

function latestByCreatedSeq<T extends { createdSeq: number }>(items: readonly T[]): T | undefined {
  return items.reduce<T | undefined>(
    (latest, item) => (latest === undefined || item.createdSeq > latest.createdSeq ? item : latest),
    undefined,
  );
}

function handlesOverlapSelection(
  handles: readonly string[],
  selection: Extract<ReversalSelection, { kind: "single" | "range" }>,
): boolean {
  if (selection.kind === "single") return handles.includes(selection.to);
  const from = parseWriteHandle(selection.from);
  const to = parseWriteHandle(selection.to);
  if (from === undefined || to === undefined) return false;
  return handles.some((handle) => {
    const ordinal = parseWriteHandle(handle);
    return ordinal !== undefined && ordinal >= from && ordinal <= to;
  });
}

function sortHandles(handles: readonly string[]): string[] {
  return [...handles].sort(
    (left, right) => (parseWriteHandle(left) ?? 0) - (parseWriteHandle(right) ?? 0),
  );
}
