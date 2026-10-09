/** review-files — the Work's draft files as the lists show them: one target per document, in one order. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";

import { pendingReviewDraft, type ThreadDraftGroup } from "@/client/query/useWorkDrafts";

/** One document's active draft, as a file in a list of the Work's drafts. */
export type ReviewFileTarget = {
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  /** The active draft the row's verbs act on. */
  draft: ThreadDraftListItem;
  /**
   * the draft proposes a document not yet in the writer's live project
   * (spec §5.5). Drives the row's `New` badge + additions-only stats and the
   * review card's `New document` label. Read straight off the draft item field
   * the S4 server lane produces.
   */
  isNewDocument: boolean;
};

/**
 * Collapse work draft groups into file rows. Each document contributes at most
 * one row for its active draft, in the one file order (`sortDraftFiles`).
 */
export function reviewFileTargets(
  groups: ThreadDraftGroup[] | null | undefined,
): ReviewFileTarget[] {
  if (!groups || groups.length === 0) return [];
  const rows: ReviewFileTarget[] = [];
  for (const group of groups) {
    const draft = pendingReviewDraft(group);
    if (!draft) continue;
    rows.push({
      documentId: group.documentId,
      documentName: group.documentName,
      contextPath: group.contextPath,
      draft,
      isNewDocument: draft.isNewDocument === true,
    });
  }
  return sortDraftFiles(rows);
}

/**
 * The one order every list of draft files uses (the composer strip, the Work
 * page's Changes to review, and "Next draft"): by the
 * name each file is shown under, then by id. Drafts carry no creation time and
 * an update time would reshuffle the list as the AI keeps writing, so a file
 * keeps its place until its name changes.
 */
export function sortDraftFiles<
  T extends { documentId: string; documentName: string | null; contextPath: string | null },
>(files: readonly T[]): T[] {
  const key = (file: T) =>
    (file.documentName ?? documentBasename(file.contextPath) ?? file.documentId).toLowerCase();
  return [...files].sort(
    (left, right) =>
      key(left).localeCompare(key(right)) || left.documentId.localeCompare(right.documentId),
  );
}

/**
 * The draft the review moves to when the writer is done with this one: the next
 * document in the file order, wrapping to the first, and none when this is
 * the only one left (the review then returns to live).
 */
export function nextReviewFile(
  rows: readonly ReviewFileTarget[],
  documentId: string,
  /** The document's name once its draft has left the list: it keeps its place in the order. */
  closedName: string | null = null,
): ReviewFileTarget | null {
  const others = rows.filter((row) => row.documentId !== documentId);
  if (others.length === 0) return null;
  let at = rows.findIndex((row) => row.documentId === documentId);
  let ordered = rows;
  if (at < 0 && closedName !== null) {
    const closed = { documentId, documentName: closedName, contextPath: null };
    ordered = sortDraftFiles([...rows, closed]) as readonly ReviewFileTarget[];
    at = ordered.findIndex((row) => row.documentId === documentId);
  }
  const after = at < 0 ? [] : ordered.slice(at + 1).filter((row) => row.documentId !== documentId);
  return after[0] ?? others[0];
}

/**
 * The basename of a document's context path (`work://drafts/ch-3.md` → `ch-3.md`),
 * or `null` when there's no usable path. New documents are URI-addressed, so the
 * basename is the display name when the AI created the doc unnamed (spec §5.5,
 * product call 2026-07-05). Trailing slashes are ignored.
 */
export function documentBasename(contextPath: string | null | undefined): string | null {
  if (!contextPath) return null;
  const trimmed = contextPath.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base.length > 0 ? base : null;
}

/**
 * What a draft's document is called: its name, else (for a new document the AI
 * created unnamed) the basename of its path, then a defensive label.
 */
export function reviewFileTargetName(row: ReviewFileTarget, untitled: string): string {
  return (
    row.documentName ??
    (row.isNewDocument ? (documentBasename(row.contextPath) ?? untitled) : row.documentId)
  );
}
