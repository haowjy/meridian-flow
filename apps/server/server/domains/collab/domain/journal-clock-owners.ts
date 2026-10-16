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
  const introduced: RangeLookup = new Map();
  const deleted: RangeLookup = new Map();
  const replayDoc = cloneDoc(input.baseDoc);

  try {
    for (const update of input.updates) {
      const operationId = String(update.id);
      const decoded = Y.decodeUpdate(update.updateData);
      const beforeVisibility = deleteSetRanges(decoded.ds)
        .flatMap((range) => splitRangeAtStructBoundaries(replayDoc, range))
        .map((range) => ({ range, visible: isRangeVisible(replayDoc, range) }));
      const introducedRanges = decoded.structs.flatMap((struct) => {
        // Reconnect frames repeat old structs. Only novel clocks acquire the current row's
        // ownership; inherited bytes keep their earlier owner.
        const clock = Math.max(struct.id.clock, Y.getState(replayDoc.store, struct.id.client));
        const length = struct.id.clock + struct.length - clock;
        return length > 0 ? [{ client: struct.id.client, clock, length }] : [];
      });

      Y.applyUpdate(replayDoc, update.updateData);

      for (const { range, visible: wasVisible } of beforeVisibility) {
        if (wasVisible && !isRangeVisible(replayDoc, range)) {
          appendAssignment(deleted, range, operationId);
        }
      }
      for (const range of introducedRanges) {
        appendAssignment(introduced, range, operationId);
      }
    }
  } finally {
    replayDoc.destroy();
  }

  normalizeAssignments(introduced);
  normalizeAssignments(deleted);

  return {
    owningRowIds({ insertedRanges, deletedRanges }) {
      const ids = new Set<string>();
      for (const range of insertedRanges) addMatchingOperations(ids, introduced, range);
      for (const range of deletedRanges) addMatchingOperations(ids, deleted, range);
      return [...ids].sort();
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
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (candidates[mid].end <= start) low = mid + 1;
    else high = mid;
  }
  for (let index = low; index < candidates.length && candidates[index].start < end; index++) {
    ids.add(candidates[index].operationId);
  }
  return [...ids].sort();
}

function appendAssignment(lookup: RangeLookup, range: ClockRange, operationId: string): void {
  let assignments = lookup.get(range.client);
  if (!assignments) {
    assignments = [];
    lookup.set(range.client, assignments);
  }
  assignments.push({ start: range.clock, end: range.clock + range.length, operationId });
}

/** Last assignment wins, including repeated clocks from updates awaiting a dependency. */
function normalizeAssignments(lookup: RangeLookup): void {
  for (const [client, assignments] of lookup) {
    const boundaries = [...new Set(assignments.flatMap(({ start, end }) => [start, end]))].sort(
      (a, b) => a - b,
    );
    const positions = new Map(boundaries.map((clock, index) => [clock, index]));
    const owners: Array<string | undefined> = new Array(boundaries.length - 1);
    const next = boundaries.map((_, index) => index);
    // Paint newest first. The disjoint-set successor skips spans already owned, so each
    // elementary interval is visited once even when reconnect frames overlap every range.
    const unassigned = (index: number): number => {
      let root = index;
      while (next[root] !== root) root = next[root];
      while (next[index] !== index) {
        const parent = next[index];
        next[index] = root;
        index = parent;
      }
      return root;
    };
    for (let index = assignments.length - 1; index >= 0; index--) {
      const range = assignments[index];
      const end = positions.get(range.end) as number;
      for (
        let span = unassigned(positions.get(range.start) as number);
        span < end;
        span = unassigned(span)
      ) {
        owners[span] = range.operationId;
        next[span] = unassigned(span + 1);
      }
    }
    const normalized: RangeAssignment[] = [];
    for (let index = 0; index < owners.length; index++) {
      const operationId = owners[index];
      if (operationId === undefined) continue;
      const previous = normalized.at(-1);
      if (previous?.operationId === operationId && previous.end === boundaries[index]) {
        previous.end = boundaries[index + 1];
      } else {
        normalized.push({ start: boundaries[index], end: boundaries[index + 1], operationId });
      }
    }
    lookup.set(client, normalized);
  }
}
