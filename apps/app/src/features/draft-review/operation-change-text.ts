/** Formats a review operation as concise change text. */
import { t } from "@lingui/core/macro";
import type {
  ReviewFormattingChange,
  ReviewHunk,
  ReviewOperation,
} from "@meridian/contracts/drafts";

export type OperationChangeText = {
  removed: string | null;
  added: string | null;
  formatting?: ReviewFormattingChange[];
};

/**
 * What these hunks took out and put in. An unclassified text hunk has no
 * operation to carry an excerpt, so its own `insertedText` is the insertion;
 * `operations` only supply excerpts when the hunks themselves say nothing.
 */
export function changeTextForHunks(
  hunks: readonly ReviewHunk[],
  operations: readonly ReviewOperation[] = [],
): OperationChangeText {
  const formatting = hunks.flatMap((hunk) =>
    hunk.kind === "block" ? (hunk.formatting ?? []) : [],
  );
  const removedParts: string[] = [];
  const addedParts: string[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === "text") {
      if (hunk.deletedText) removedParts.push(hunk.deletedText);
      if (hunk.unclassified && hunk.insertedText) addedParts.push(hunk.insertedText);
    } else {
      if (hunk.formatting) continue;
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
  if (formatting.length && removedParts.length === 0 && addedParts.length === 0)
    return { removed: null, added: null, formatting };
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

/** Wording is provisional and intentionally lives in the normal messages.po catalog. */
export function formattingChangeText(change: ReviewFormattingChange): string {
  if (change.kind === "heading") {
    const { before, after } = change;
    return t`Heading ${before} → ${after}`;
  }
  if (change.kind === "block") {
    const before = blockLabel(change.before),
      after = blockLabel(change.after);
    return t`${before} → ${after}`;
  }
  if (change.kind === "attributes") return t`Formatting changed`;
  if (change.kind === "structure") return t`Structure changed`;
  const text = change.text.replace(/\s+/g, " ").slice(0, 60);
  const mark = markLabel(change.mark);
  if (change.change === "added") return t`${mark} on “${text}”`;
  if (change.change === "removed") return t`${mark} off “${text}”`;
  return t`${mark} changed on “${text}”`;
}

function markLabel(mark: string): string {
  switch (mark) {
    case "strong":
      return t`Bold`;
    case "em":
      return t`Italic`;
    case "link":
      return t`Link`;
    case "code":
      return t`Code`;
    case "strike":
      return t`Strikethrough`;
    default:
      return t`Formatting`;
  }
}

function blockLabel(type: string): string {
  switch (type) {
    case "paragraph":
      return t`Paragraph`;
    case "heading":
      return t`Heading`;
    case "bullet_list":
      return t`Bullet list`;
    case "ordered_list":
      return t`Numbered list`;
    default:
      return t`Block`;
  }
}
