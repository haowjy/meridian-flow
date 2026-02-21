import * as Y from "yjs";
import type { ReviewChunk } from "./types";

/**
 * Constructs a Yjs update that applies only one chunk's text changes to the given doc.
 *
 * The caller should apply the returned update to the LIVE Y.Doc (not a clone):
 *   Y.applyUpdate(liveDoc, buildPartialUpdate(liveDoc, chunk));
 *
 * The Yjs collab system will broadcast this update to other clients.
 * Does NOT mutate `baseDoc` — clones it internally.
 *
 * IMPORTANT: `chunk.baseStart` and `chunk.baseEnd` are offsets in the base text at the
 * time the chunk was derived. The `baseDoc` must be the SAME doc state that was used to
 * derive the chunk. This is always true when called immediately on chunk accept (before
 * any other Y.Doc mutations happen).
 */
export function buildPartialUpdate(
  baseDoc: Y.Doc,
  chunk: ReviewChunk,
  textKey = "content",
): Uint8Array {
  // 1. Clone baseDoc so we don't mutate the original
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(baseDoc));

  // 2. Capture state vector before the edit so we can extract only the new ops
  const before = Y.encodeStateVector(clone);

  // 3. Apply the chunk's text edit in a single transaction
  const ytext = clone.getText(textKey);
  clone.transact(() => {
    // Delete first (if the chunk covers a base range), then insert
    if (chunk.baseEnd > chunk.baseStart) {
      ytext.delete(chunk.baseStart, chunk.baseEnd - chunk.baseStart);
    }
    if (chunk.insertedText) {
      ytext.insert(chunk.baseStart, chunk.insertedText);
    }
  });

  // 4. Return only the new operations (the diff between before and after)
  return Y.encodeStateAsUpdate(clone, before);
}
