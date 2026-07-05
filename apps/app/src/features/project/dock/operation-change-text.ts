/**
 * operation-change-text — pure card-body extraction for dock Changes cards.
 *
 * Turns one review operation + the preview hunks into the text a card shows
 * (removed side, added side), richest-first: full passages from the hunks,
 * falling back to the operation's word-bound excerpts. No React, no view
 * concerns — the card module renders whatever this returns.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";

export type OperationChangeText = { removed: string | null; added: string | null };

/**
 * The change text for one operation, richest-first. Removed text and whole
 * removed/inserted blocks come from the hunks (`deletedText`, block displays),
 * which carry the full passage; the operation's word-bound excerpts are the
 * fallback. Inline INSERTED text is not on the wire per operation — it lives in
 * the preview document positioned by Yjs anchors the dock can't resolve — so the
 * added side of a text edit stays excerpt-only (`afterExcerpt`).
 */
export function operationChangeText(
  operation: ReviewOperation,
  hunks: ReviewHunk[],
): OperationChangeText {
  const removedParts: string[] = [];
  const addedBlockParts: string[] = [];
  for (const hunk of hunks) {
    if (!hunk.operationIds.includes(operation.operationId)) continue;
    if (hunk.kind === "text") {
      if (hunk.deletedText) removedParts.push(hunk.deletedText);
    } else {
      // Structural block displays (horizontal_rule → "───") are decoration,
      // not prose: a card body of nothing but separators reads as broken, so
      // only displays with actual words count as content here.
      if (hunk.deletedBlock && hasProse(hunk.deletedBlock.display)) {
        removedParts.push(hunk.deletedBlock.display);
      }
      if (hunk.insertedBlock && hasProse(hunk.insertedBlock.display)) {
        addedBlockParts.push(hunk.insertedBlock.display);
      }
    }
  }
  return {
    removed: joinTrim(removedParts) ?? trimToNull(operation.beforeExcerpt),
    added: joinTrim(addedBlockParts) ?? trimToNull(operation.afterExcerpt),
  };
}

function hasProse(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function joinTrim(parts: string[]): string | null {
  return trimToNull(parts.join("\n"));
}

function trimToNull(text: string | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}
