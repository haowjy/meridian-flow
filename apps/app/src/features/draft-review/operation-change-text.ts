/** Formats a review operation as concise change text. */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";

export type OperationChangeText = { removed: string | null; added: string | null };

/** The agent operations whose changes share a hunk with the writer's own edits. */
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

export function changeTextForOperations(
  operations: readonly ReviewOperation[],
  hunks: ReviewHunk[],
): OperationChangeText {
  const opIds = new Set(operations.map((op) => op.operationId));
  return changeTextForHunks(
    hunks.filter((hunk) => hunk.operationIds.some((id) => opIds.has(id))),
    operations,
  );
}

/**
 * What these hunks took out and put in. An unclassified text hunk has no
 * operation to carry an excerpt, so its own `insertedText` is the insertion;
 * `operations` only supply excerpts when the hunks themselves say nothing.
 */
export function changeTextForHunks(
  hunks: readonly ReviewHunk[],
  operations: readonly ReviewOperation[] = [],
): OperationChangeText {
  const removedParts: string[] = [];
  const addedParts: string[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === "text") {
      if (hunk.deletedText) removedParts.push(hunk.deletedText);
      if (hunk.unclassified && hunk.insertedText) addedParts.push(hunk.insertedText);
    } else {
      // Structural block displays (horizontal_rule → "───") are decoration,
      // not prose: a card body of nothing but separators reads as broken, so
      // only displays with actual words count as content here.
      if (hunk.deletedBlock && hasProse(hunk.deletedBlock.display)) {
        removedParts.push(hunk.deletedBlock.display);
      }
      if (hunk.insertedBlock && hasProse(hunk.insertedBlock.display)) {
        addedParts.push(hunk.insertedBlock.display);
      }
    }
  }
  return {
    removed:
      joinTrim(removedParts) ??
      joinTrim(operations.map((op) => op.beforeExcerpt ?? "").filter(Boolean)),
    added:
      joinTrim(addedParts) ??
      joinTrim(operations.map((op) => op.afterExcerpt ?? "").filter(Boolean)),
  };
}

function hasProse(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Operations of one change overlap: the writer's edit inside an AI insert
 * reports the text around it again, so the same words arrive from several
 * operations. A part another part already contains adds nothing.
 */
function joinTrim(parts: string[]): string | null {
  const trimmed = parts.map((part) => part.trim()).filter(Boolean);
  const distinct = trimmed.filter(
    (part, index) =>
      !trimmed.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.includes(part) &&
          (other.length > part.length || otherIndex < index),
      ),
  );
  return trimToNull(distinct.join("\n"));
}

function trimToNull(text: string | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}
