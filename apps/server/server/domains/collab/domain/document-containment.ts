/** Exact, mutation-aware containment checks for live Yjs documents. */

import * as Y from "yjs";

type CachedDocumentSnapshot = {
  snapshot: Y.Snapshot | null;
  stateVector: Map<number, number> | null;
};

/**
 * Retains one exact snapshot for each current document state. Yjs update events
 * invalidate the snapshot synchronously, including for delete-only mutations
 * whose state vector does not change. Pending state is not tied to this cache:
 * an update that only adds to it emits no update event, so its index is keyed by
 * the pending bytes instead.
 */
export function createDocumentContainment() {
  const snapshots = new WeakMap<Y.Doc, CachedDocumentSnapshot>();

  function cacheFor(document: Y.Doc): CachedDocumentSnapshot {
    let cached = snapshots.get(document);
    if (!cached) {
      const entry: CachedDocumentSnapshot = { snapshot: null, stateVector: null };
      cached = entry;
      snapshots.set(document, entry);
      document.on("update", () => {
        entry.snapshot = null;
        entry.stateVector = null;
      });
    }
    return cached;
  }

  function snapshotFor(document: Y.Doc): Y.Snapshot {
    const cached = cacheFor(document);
    cached.snapshot ??= Y.snapshot(document);
    return cached.snapshot;
  }

  return {
    contains(document: Y.Doc, update: Uint8Array): boolean {
      const cached = cacheFor(document);
      cached.stateVector ??= Y.decodeStateVector(Y.encodeStateVector(document));
      return containedIn(document, cached.stateVector, () => snapshotFor(document), update);
    },
  };
}

/** `update` judged against `document` once, with no cache: for a document built per call. */
export function documentContainsUpdate(document: Y.Doc, update: Uint8Array): boolean {
  return containedIn(
    document,
    Y.decodeStateVector(Y.encodeStateVector(document)),
    () => Y.snapshot(document),
    update,
  );
}

/**
 * Whether applying `update` would change `document`: every struct is integrated or pending,
 * and every delete is applied or pending. Yjs holds structs whose predecessor has not arrived,
 * and deletes of clocks it has not seen, apart from the integrated store; its state vector and
 * snapshot leave both out, so a second copy of a pending update would otherwise look new.
 */
function containedIn(
  document: Y.Doc,
  stateVector: Map<number, number>,
  snapshot: () => Y.Snapshot,
  update: Uint8Array,
): boolean {
  const { pendingStructs, pendingDs } = document.store;
  if (!pendingStructs && !pendingDs) {
    // Struct novelty is sufficient to reject containment. The inverse is not
    // sufficient: delete-only updates must still use the exact predicate.
    for (const [clientId, endClock] of Y.parseUpdateMeta(update).to) {
      if (endClock > (stateVector.get(clientId) ?? 0)) return false;
    }
    return Y.snapshotContainsUpdate(snapshot(), update);
  }

  const pending = pendingStructs ? pendingIndexFor(pendingStructs.update) : EMPTY_INDEX;
  const incoming = Y.decodeUpdate(update);
  for (const struct of incoming.structs) {
    // A Skip marks a hole in a merged update; applying it is a no-op.
    if (struct instanceof Y.Skip) continue;
    const { client, clock } = struct.id;
    const integratedEnd = stateVector.get(client) ?? 0;
    const end = clock + struct.length;
    if (end <= integratedEnd) continue;
    if (!covers(pending, client, Math.max(clock, integratedEnd), end)) return false;
  }
  const stored = Y.mergeDeleteSets(
    pendingDs ? [snapshot().ds, Y.decodeUpdateV2(pendingDs).ds] : [snapshot().ds],
  );
  return Y.equalDeleteSets(stored, Y.mergeDeleteSets([stored, incoming.ds]));
}

/** Per client, the pending clock ranges sorted by start with touching ranges merged. */
type PendingIndex = Map<number, { starts: number[]; ends: number[] }>;

const EMPTY_INDEX: PendingIndex = new Map();

// Keyed by the pending bytes themselves: Yjs replaces `pendingStructs.update` with a fresh
// array whenever pending state changes, and a pending-only change fires no update event, so
// identity is the one signal that tracks it exactly. Building the index once per pending
// state keeps a check linear in the incoming update; rebuilding it per struct made a
// 20,000-Item frame block the process for seconds.
const pendingIndexes = new WeakMap<Uint8Array, PendingIndex>();

function pendingIndexFor(update: Uint8Array): PendingIndex {
  let index = pendingIndexes.get(update);
  if (!index) {
    // Pending bytes are V2 updates; incoming frames are V1.
    index = buildPendingIndex(Y.decodeUpdateV2(update).structs);
    pendingIndexes.set(update, index);
  }
  return index;
}

function buildPendingIndex(structs: readonly (Y.Item | Y.GC | Y.Skip)[]): PendingIndex {
  const byClient = new Map<number, { start: number; end: number }[]>();
  for (const struct of structs) {
    if (struct instanceof Y.Skip) continue;
    const { client, clock } = struct.id;
    let ranges = byClient.get(client);
    if (!ranges) {
      ranges = [];
      byClient.set(client, ranges);
    }
    ranges.push({ start: clock, end: clock + struct.length });
  }
  const index: PendingIndex = new Map();
  for (const [client, ranges] of byClient) {
    ranges.sort((left, right) => left.start - right.start);
    const starts: number[] = [];
    const ends: number[] = [];
    for (const range of ranges) {
      const last = ends.length - 1;
      // Merge only ranges that touch or overlap; a gap must stay a gap.
      if (last >= 0 && range.start <= ends[last]) ends[last] = Math.max(ends[last], range.end);
      else {
        starts.push(range.start);
        ends.push(range.end);
      }
    }
    index.set(client, { starts, ends });
  }
  return index;
}

/** Whether pending ranges of `client` cover `[start, end)` without a gap. */
function covers(index: PendingIndex, client: number, start: number, end: number) {
  const ranges = index.get(client);
  if (!ranges) return false;
  // Coalesced ranges are disjoint and gapped, so coverage needs one range spanning the query:
  // the last one starting at or before `start`.
  let low = 0;
  let high = ranges.starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges.starts[middle] <= start) low = middle + 1;
    else high = middle;
  }
  return low > 0 && ranges.ends[low - 1] >= end;
}
