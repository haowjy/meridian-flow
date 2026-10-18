/** Captures an explicit coarse historical fixture row; Apply still uses the canonical batch seam. */
import * as Y from "yjs";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";

export async function captureHistoricalDraftRow(
  coordinator: DraftCoordinator,
  draftId: string,
  sourceDoc: Y.Doc,
): Promise<Uint8Array> {
  return coordinator.readDraft(draftId, async (target) => {
    const replay = new Y.Doc({ gc: false });
    Y.applyUpdate(replay, Y.encodeStateAsUpdate(target));
    const updates: Uint8Array[] = [];
    replay.on("update", (update: Uint8Array) => updates.push(update));
    try {
      Y.applyUpdate(replay, Y.encodeStateAsUpdate(sourceDoc, Y.encodeStateVector(target)));
      if (replay.store.pendingStructs || replay.store.pendingDs)
        throw new Error("Historical fixture row has unresolved dependencies");
      return updates.length ? Y.mergeUpdates(updates) : new Uint8Array([0, 0]);
    } finally {
      replay.destroy();
    }
  });
}
