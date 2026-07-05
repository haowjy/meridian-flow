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
 * The agent operations whose changes share a hunk with the writer's own edits.
 * Ported from the deleted DraftReviewSidebar: discarding such an operation also
 * removes the writer's edits in that passage, so the card must confirm before
 * it does — a data-loss-adjacent step. Returns only agent op ids (the writer's
 * own operations aren't discarded from a card).
 */
export function operationsWithWriterEdits(
  operations: ReviewOperation[],
  hunks: ReviewHunk[],
): ReadonlySet<string> {
  const kindById = new Map(operations.map((op) => [op.operationId, op.kind]));
  const mixed = new Set<string>();
  for (const hunk of hunks) {
    let sawAgent = false;
    let sawWriter = false;
    for (const opId of hunk.operationIds) {
      const kind = kindById.get(opId);
      if (kind === "agent") sawAgent = true;
      else if (kind === "writer") sawWriter = true;
    }
    if (!sawAgent || !sawWriter) continue;
    for (const opId of hunk.operationIds) {
      if (kindById.get(opId) === "agent") mixed.add(opId);
    }
  }
  return mixed;
}

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
