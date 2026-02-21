import { Change } from "@codemirror/merge";
import type { ReviewChunk } from "./types";

/**
 * Converts ReviewChunk[] to @codemirror/merge Change[] format.
 *
 * Tracks a proposedText offset as chunks are applied in base-text order
 * (chunks are already sorted by baseStart from groupIntoChunks).
 *
 * Approach (Path A): override bypasses CM6's diff algorithm entirely.
 * Our Change[] come from Yjs delta operations with exact positions,
 * so no re-diffing or normalization is needed.
 *
 * Formula per chunk:
 *   insert:  fromA=baseStart, toA=baseStart, fromB=baseStart+offset, toB=baseStart+offset+insertLen; offset += insertLen
 *   delete:  fromA=baseStart, toA=baseEnd,   fromB=baseStart+offset, toB=baseStart+offset;           offset -= deleteLen
 *   replace: fromA=baseStart, toA=baseEnd,   fromB=baseStart+offset, toB=baseStart+offset+insertLen; offset += insertLen - deleteLen
 */
export function editOpsToMergeChanges(chunks: ReviewChunk[]): Change[] {
  let offset = 0;
  const changes: Change[] = [];

  for (const chunk of chunks) {
    const { baseStart, baseEnd, insertedText } = chunk;
    const deleteLen = baseEnd - baseStart;
    const insertLen = insertedText.length;

    if (deleteLen === 0 && insertLen > 0) {
      // Pure insert
      changes.push(
        new Change(baseStart, baseStart, baseStart + offset, baseStart + offset + insertLen),
      );
      offset += insertLen;
    } else if (insertLen === 0 && deleteLen > 0) {
      // Pure delete
      changes.push(new Change(baseStart, baseEnd, baseStart + offset, baseStart + offset));
      offset -= deleteLen;
    } else if (deleteLen > 0 && insertLen > 0) {
      // Replace
      changes.push(
        new Change(baseStart, baseEnd, baseStart + offset, baseStart + offset + insertLen),
      );
      offset += insertLen - deleteLen;
    }
    // No-op chunks (both zero) are skipped.
  }

  return changes;
}
