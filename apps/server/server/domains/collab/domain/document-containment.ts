/** Exact, mutation-aware containment checks for live Yjs documents. */

import * as Y from "yjs";

type CachedDocumentSnapshot = {
  snapshot: Y.Snapshot | null;
  stateVector: Map<number, number> | null;
};

/**
 * Retains one exact snapshot for each current document state. Yjs update events
 * invalidate the snapshot synchronously, including for delete-only mutations
 * whose state vector does not change. Pending state is read per call: an update
 * that only adds to it emits no update event.
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

  // Pending bytes are V2 updates; incoming frames are V1.
  const pending = pendingStructs
    ? clockRanges(Y.decodeUpdateV2(pendingStructs.update).structs)
    : [];
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

type ClockRange = { client: number; start: number; end: number };

function clockRanges(structs: readonly (Y.Item | Y.GC | Y.Skip)[]): ClockRange[] {
  return structs
    .filter((struct) => !(struct instanceof Y.Skip))
    .map((struct) => ({
      client: struct.id.client,
      start: struct.id.clock,
      end: struct.id.clock + struct.length,
    }));
}

/** Whether `ranges` of `client` cover `[start, end)` without a gap. */
function covers(ranges: readonly ClockRange[], client: number, start: number, end: number) {
  let reached = start;
  const sorted = ranges
    .filter((range) => range.client === client && range.end > start)
    .sort((left, right) => left.start - right.start);
  for (const range of sorted) {
    if (range.start > reached) return false;
    reached = Math.max(reached, range.end);
    if (reached >= end) return true;
  }
  return reached >= end;
}
