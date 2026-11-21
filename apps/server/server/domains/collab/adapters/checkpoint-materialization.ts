/** Replay immutable journal inputs cooperatively, without taking database locks. */
import { setImmediate } from "node:timers/promises";
import { dropUnseenContent } from "@meridian/agent-edit/integration";
import * as Y from "yjs";

/** A materialized checkpoint, and the shape of the history it stores. */
export type MaterializedCheckpoint = {
  state: Uint8Array;
  /** Yjs structs the state holds, deleted ones included: what every load and copy walks. */
  structs: number;
  /** UTF-8 bytes of the text the document shows: what the history is a multiple of. */
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
    dropUnseenContent(doc, await frontiers());
    let structs = 0;
    let contentBytes = 0;
    for (const clientStructs of doc.store.clients.values()) {
      structs += clientStructs.length;
      for (const struct of clientStructs)
        if (
          struct instanceof Y.Item &&
          !struct.deleted &&
          struct.content instanceof Y.ContentString
        )
          contentBytes += Buffer.byteLength(struct.content.str);
    }
    return { state: Y.encodeStateAsUpdate(doc), structs, contentBytes };
  } finally {
    doc.destroy();
  }
}
