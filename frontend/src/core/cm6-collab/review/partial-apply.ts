import * as Y from "yjs";
import type { ReviewHunk } from "./types";

export interface BuildPartialUpdateOptions {
  /**
   * Optional override for this hunk's inserted text.
   * `""` is valid and means "delete-only" for the hunk range.
   */
  insertedTextOverride?: string;
}

/**
 * Constructs a Yjs update that applies only one hunk's text changes to the given doc.
 *
 * The caller should apply the returned update to the LIVE Y.Doc (not a clone):
 *   Y.applyUpdate(liveDoc, buildPartialUpdate(liveDoc, hunk));
 *
 * The Yjs collab system will broadcast this update to other clients.
 * Does NOT mutate `baseDoc` — clones it internally.
 *
 * IMPORTANT: `hunk.baseStart` and `hunk.baseEnd` are offsets in the base text at the
 * time the hunk was derived. The `baseDoc` must be the SAME doc state that was used to
 * derive the hunk. This is always true when called immediately on hunk accept (before
 * any other Y.Doc mutations happen).
 */
export function buildPartialUpdate(
  baseDoc: Y.Doc,
  hunk: ReviewHunk,
  textKey = "content",
  options: BuildPartialUpdateOptions = {},
): Uint8Array {
  const insertedText = options.insertedTextOverride ?? hunk.insertedText;

  // 1. Clone baseDoc so we don't mutate the original
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(baseDoc));

  // 2. Capture state vector before the edit so we can extract only the new ops
  const before = Y.encodeStateVector(clone);

  // 3. Apply the hunk's text edit in a single transaction
  const ytext = clone.getText(textKey);
  clone.transact(() => {
    // Delete first (if the hunk covers a base range), then insert
    if (hunk.baseEnd > hunk.baseStart) {
      ytext.delete(hunk.baseStart, hunk.baseEnd - hunk.baseStart);
    }
    if (insertedText.length > 0) {
      ytext.insert(hunk.baseStart, insertedText);
    }
  });

  // 4. Return only the new operations (the diff between before and after)
  return Y.encodeStateAsUpdate(clone, before);
}

/**
 * Convenience helper for applying one hunk with writer-edited inserted text.
 */
export function buildEditedHunkUpdate(
  baseDoc: Y.Doc,
  hunk: ReviewHunk,
  editedInsertedText: string,
  textKey = "content",
): Uint8Array {
  return buildPartialUpdate(baseDoc, hunk, textKey, {
    insertedTextOverride: editedInsertedText,
  });
}
