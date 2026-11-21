/** Replay immutable journal inputs cooperatively, without taking database locks. */
import { setImmediate } from "node:timers/promises";
import { dropUnseenContent } from "@meridian/agent-edit/integration";
import * as Y from "yjs";

/** A materialized checkpoint, and the shape of the history it stores. */
export type MaterializedCheckpoint = {
  state: Uint8Array;
  structs: number;
  contentBytes: number;
};

/**
 * The state of `base` with `updates` applied, deleted content dropped except what one of
 * `frontiers` (the room's latest model read) shows. A version and the background
 * checkpoint alike: each is the base a later load or capture replays from, so it keeps every
 * item id the journal rows after it may name.
 */
export async function materializeCheckpoint(
  base: Uint8Array | null,
  updates: readonly Uint8Array[],
  frontiers: () => Promise<readonly Uint8Array[]>,
): Promise<MaterializedCheckpoint> {
  const doc = new Y.Doc({ gc: false });
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
    const shape = dropUnseenContent(doc, await frontiers());
    return { state: Y.encodeStateAsUpdate(doc), ...shape };
  } finally {
    doc.destroy();
  }
}
