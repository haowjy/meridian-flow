/** Exact, mutation-aware containment checks for live Yjs documents. */

import * as Y from "yjs";

type CachedDocumentSnapshot = {
  snapshot: Y.Snapshot | null;
  stateVector: Map<number, number> | null;
};

export type DocumentContainment = ReturnType<typeof createDocumentContainment>;

/**
 * Retains one exact snapshot for each current document state. Yjs update events
 * invalidate the snapshot synchronously, including for delete-only mutations
 * whose state vector does not change.
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

      // Struct novelty is sufficient to reject containment. The inverse is not
      // sufficient: delete-only updates must still use the exact predicate.
      for (const [clientId, endClock] of Y.parseUpdateMeta(update).to) {
        if (endClock > (cached.stateVector.get(clientId) ?? 0)) return false;
      }
      return Y.snapshotContainsUpdate(snapshotFor(document), update);
    },
  };
}
