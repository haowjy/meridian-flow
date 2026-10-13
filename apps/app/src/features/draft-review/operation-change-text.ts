/** Complete review text runs and localized formatting labels. */
import { t } from "@lingui/core/macro";
import type {
  ReviewFormattingChange,
  ReviewHunk,
  ReviewOperation,
} from "@meridian/contracts/drafts";

export type ChangeTextRun = { kind: "removed" | "added"; text: string };
export type OperationChangeText = {
  runs: ChangeTextRun[];
  formatting?: ReviewFormattingChange[];
};

/** Complete visible hunk runs in document order, not the operations' first-hunk excerpts. */
export function changeTextForHunks(
  hunks: readonly ReviewHunk[],
  operations: readonly ReviewOperation[] = [],
): OperationChangeText {
  const formatting = hunks.flatMap((hunk) =>
    hunk.kind === "block" ? (hunk.formatting ?? []) : [],
  );
  const runs: ChangeTextRun[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === "text") {
      if (hunk.deletedText) runs.push({ kind: "removed", text: hunk.deletedText });
      if (hunk.insertedText) runs.push({ kind: "added", text: hunk.insertedText });
    } else {
      if (hunk.formatting) continue;
      // Structural separators are decoration rather than prose.
      if (hunk.deletedBlock && hasProse(hunk.deletedBlock.display))
        runs.push({ kind: "removed", text: hunk.deletedBlock.display });
      if (hunk.insertedBlock && hasProse(hunk.insertedBlock.display))
        runs.push({ kind: "added", text: hunk.insertedBlock.display });
    }
  }
  if (runs.length) return { runs };
  if (formatting.length) return { runs, formatting };
  // A class without visible hunks can still carry an operation description.
  const removed = joinTrim(operations.map((op) => op.beforeExcerpt ?? ""));
  const added = joinTrim(operations.map((op) => op.afterExcerpt ?? ""));
  if (removed) runs.push({ kind: "removed", text: removed });
  if (added) runs.push({ kind: "added", text: added });
  return { runs };
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
