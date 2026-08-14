/** docked-drafts — pure assembly rules for the composer-attached DraftDock. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";

import { pendingReviewDraft, type ThreadDraftGroup } from "@/client/query/useWorkDrafts";

/** One document's active draft line in the dock. */
export type DockRow = {
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
 * Collapse work draft groups into dock rows. Each document contributes at most
 * one row for its active draft, sorted stably by document.
 */
export function dockRows(groups: ThreadDraftGroup[] | null | undefined): DockRow[] {
  if (!groups || groups.length === 0) return [];
  const rows: DockRow[] = [];
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
  return rows.sort((left, right) => documentSortKey(left).localeCompare(documentSortKey(right)));
}

/**
 * Whether the work-scoped Changes view has active work to show.
 */
export function hasDockChanges(groups: ThreadDraftGroup[] | null | undefined): boolean {
  return dockRows(groups).length > 0;
}

function documentSortKey(row: DockRow): string {
  return (row.documentName ?? row.documentId).toLowerCase();
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
