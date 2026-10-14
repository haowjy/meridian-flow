/**
 * Replays a draft's journal rows over its base to say which rows own a clock range. The trail uses it
 * to name the turns behind each changed block; ownership follows the net effect, so a keystroke typed
 * and then deleted owns nothing.
 */
import * as Y from "yjs";

export type ClockRange = { client: number; clock: number; length: number };

export type IndexedDraftUpdate = {
  id: number;
  actorTurnId: string | null;
  actorUserId?: string | null;
  updateData: Uint8Array;
  updateMeta?: unknown;
};

export type JournalClockOwners = {
  /** Ids of the rows whose net effect inserted or removed these ranges, sorted. */
  owningRowIds(input: {
    insertedRanges: readonly ClockRange[];
    deletedRanges: readonly ClockRange[];
  }): string[];
};

type RangeAssignment = { start: number; end: number; operationId: string };
type RangeLookup = Map<number, RangeAssignment[]>;

export function indexJournalClockOwners(input: {
  baseDoc: Y.Doc;
  updates: readonly IndexedDraftUpdate[];
}): JournalClockOwners {
  const rowsWithEffect = new Set<string>();
  const introduced: RangeLookup = new Map();
  const deleted: RangeLookup = new Map();
  const deletedHistory: RangeLookup = new Map();
  const replayDoc = cloneDoc(input.baseDoc);

  try {
    for (const update of input.updates) {
      const operationId = String(update.id);
      const decoded = Y.decodeUpdate(update.updateData);
      const beforeVisibility = deleteSetRanges(decoded.ds)
        .flatMap((range) => splitRangeAtStructBoundaries(replayDoc, range))
        .map((range) => ({ range, visible: isRangeVisible(replayDoc, range) }));
      const beforeState = Y.decodeStateVector(Y.encodeStateVector(replayDoc));
      const introducedRanges = decoded.structs.flatMap((struct) => {
        // Reconnect frames repeat old structs. Only novel clocks acquire the current row's
        // ownership; inherited bytes keep their earlier owner.
        const clock = Math.max(struct.id.clock, beforeState.get(struct.id.client) ?? 0);
        const length = struct.id.clock + struct.length - clock;
        return length > 0 ? [{ client: struct.id.client, clock, length }] : [];
      });

      Y.applyUpdate(replayDoc, update.updateData);

      for (const { range, visible: wasVisible } of beforeVisibility) {
        if (wasVisible && !isRangeVisible(replayDoc, range)) {
          setAssignedRange(deleted, range, operationId);
          setAssignedRange(deletedHistory, range, operationId);
          rowsWithEffect.add(operationId);
        }
      }
      for (const range of introducedRanges) {
        setAssignedRange(introduced, range, operationId);
        rowsWithEffect.add(operationId);
      }
    }
  } finally {
    replayDoc.destroy();
  }

  return {
    owningRowIds({ insertedRanges, deletedRanges }) {
      const ids = new Set<string>();
      for (const range of insertedRanges) addMatchingOperations(ids, introduced, range);
      for (const range of deletedRanges) {
        const beforeSize = ids.size;
        addMatchingOperations(ids, deleted, range);
        if (ids.size === beforeSize) addMatchingOperations(ids, deletedHistory, range);
      }
      return [...ids].filter((id) => rowsWithEffect.has(id)).sort();
    },
  };
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function deleteSetRanges(deleteSet: {
  clients: Map<number, Array<{ clock: number; len: number }>>;
}): ClockRange[] {
  const ranges: ClockRange[] = [];
  for (const [client, clientRanges] of deleteSet.clients) {
    for (const range of clientRanges) {
      ranges.push({ client, clock: range.clock, length: range.len });
    }
  }
  return ranges;
}

/** A single delete-set range can mix old tombstones and newly removed structs; visibility is per struct. */
function splitRangeAtStructBoundaries(doc: Y.Doc, range: ClockRange): ClockRange[] {
  const ranges: ClockRange[] = [];
  const end = range.clock + range.length;
  let clock = range.clock;
  // State-vector updates echo cumulative deletes. A single delete-set range can
  // contain old tombstones and newly removed structs; visibility is per struct.
  while (clock < end) {
    const item = findItem(doc, range.client, clock);
    const next = item ? Math.min(end, item.id.clock + item.length) : end;
    ranges.push({ client: range.client, clock, length: next - clock });
    clock = next;
  }
  return ranges;
}

function isRangeVisible(doc: Y.Doc, range: ClockRange): boolean {
  if (range.length <= 0) return false;
  let clock = range.clock;
  const end = range.clock + range.length;
  while (clock < end) {
    const item = findItem(doc, range.client, clock);
    if (!(item instanceof Y.Item) || item.deleted) return false;
    clock = Math.min(end, item.id.clock + item.length);
  }
  return true;
}

function findItem(doc: Y.Doc, client: number, clock: number): Y.Item | Y.GC | null {
  const structs = doc.store.clients.get(client) ?? [];
  let low = 0;
  let high = structs.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const item = structs[mid];
    if (clock < item.id.clock) {
      high = mid - 1;
    } else if (clock >= item.id.clock + item.length) {
      low = mid + 1;
    } else {
      return item;
    }
  }
  return null;
}

function addMatchingOperations(ids: Set<string>, lookup: RangeLookup, range: ClockRange): void {
  for (const operationId of matchingOperationIds(lookup, range)) ids.add(operationId);
}

function matchingOperationIds(lookup: RangeLookup, range: ClockRange): string[] {
  const ids = new Set<string>();
  const candidates = lookup.get(range.client) ?? [];
  const start = range.clock;
  const end = range.clock + range.length;
  for (const candidate of candidates) {
    if (candidate.start < end && start < candidate.end) ids.add(candidate.operationId);
  }
  return [...ids].sort();
}

function setAssignedRange(lookup: RangeLookup, range: ClockRange, operationId: string): void {
  const start = range.clock;
  const end = range.clock + range.length;
  const retained = (lookup.get(range.client) ?? []).flatMap((candidate) =>
    subtractRange(candidate, { start, end }),
  );
  retained.push({ start, end, operationId });
  lookup.set(range.client, mergeAssignments(retained));
}

function subtractRange(
  candidate: RangeAssignment,
  removed: { start: number; end: number },
): RangeAssignment[] {
  if (removed.end <= candidate.start || candidate.end <= removed.start) return [candidate];
  const ranges: RangeAssignment[] = [];
  if (candidate.start < removed.start) {
    ranges.push({ ...candidate, end: removed.start });
  }
  if (removed.end < candidate.end) {
    ranges.push({ ...candidate, start: removed.end });
  }
  return ranges;
}

function mergeAssignments(ranges: RangeAssignment[]): RangeAssignment[] {
  const sorted = ranges
    .filter((range) => range.start < range.end)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: RangeAssignment[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.operationId === range.operationId && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
