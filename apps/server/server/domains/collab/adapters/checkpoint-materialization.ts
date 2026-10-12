/** Replay immutable journal inputs cooperatively, without taking database locks. */
import { setImmediate } from "node:timers/promises";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export async function materializeCheckpoint(
  base: Uint8Array | null,
  updates: readonly Uint8Array[],
): Promise<Uint8Array> {
  const doc = createCollabYDoc({ gc: false });
  try {
    if (base) Y.applyUpdate(doc, base);
    let yieldAt = performance.now() + 5;
    for (const update of updates) {
      Y.applyUpdate(doc, update);
      if (performance.now() >= yieldAt) {
        await setImmediate();
        yieldAt = performance.now() + 5;
      }
    }
    if (doc.store.pendingStructs || doc.store.pendingDs) {
      throw new Error("Cannot checkpoint unresolved Yjs journal dependencies");
    }
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
