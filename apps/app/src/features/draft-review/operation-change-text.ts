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
  const removedParts: string[] = [];
  const addedBlockParts: string[] = [];
  for (const hunk of hunks) {
    if (!hunk.operationIds.some((id) => opIds.has(id))) continue;
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
    removed:
      joinTrim(removedParts) ??
      joinTrim(operations.map((op) => op.beforeExcerpt ?? "").filter(Boolean)),
    added:
      joinTrim(addedBlockParts) ??
      joinTrim(operations.map((op) => op.afterExcerpt ?? "").filter(Boolean)),
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
