/** docked-drafts — pure assembly rules for the composer-attached DraftDock. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";

import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { reviewableDraftsFromGroup } from "./DraftReviewProvider";

/** One document's line in the dock — pending (has an active draft) or reviewed. */
export type DockRow = {
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  /** The draft the row's verbs act on (the active one, or the terminal receipt). */
  draft: ThreadDraftListItem;
  state: "pending" | "reviewed";
  /**
   * the draft proposes a document not yet in the writer's live project
   * (spec §5.5). Drives the row's `New` badge + additions-only stats and the
   * review card's `Create` variant. Read straight off the draft item field the
   * S4 server lane produces.
   */
  isNewDocument: boolean;
};

/**
 * Collapse work draft groups into dock rows. Each document contributes at most
 * one row: its active draft (pending) or, if none is active but a recent
 * terminal draft is still in view, a reviewed receipt. Pending rows come first
 * (stable by document), reviewed rows after — the guided-progression order.
 */
export function dockRows(groups: ThreadDraftGroup[] | null | undefined, nowMs: number): DockRow[] {
  if (!groups || groups.length === 0) return [];
  const rows: DockRow[] = [];
  for (const group of groups) {
    const { visible, active } = reviewableDraftsFromGroup(group, nowMs);
    const draft =
      active.find(draftHasReviewContent) ?? visible.find((draft) => draft.status !== "active");
    if (!draft) continue;
    rows.push({
      documentId: group.documentId,
      documentName: group.documentName,
      contextPath: group.contextPath,
      draft,
      state: draft.status === "active" ? "pending" : "reviewed",
      isNewDocument: draft.isNewDocument === true,
    });
  }
  return rows.sort((left, right) => {
    if (left.state !== right.state) return left.state === "pending" ? -1 : 1;
    return documentSortKey(left).localeCompare(documentSortKey(right));
  });
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

/** Groups that still carry an active draft — the dock exists iff this is non-empty. */
export function activeDockedDraftGroups(
  groups: ThreadDraftGroup[] | null | undefined,
): ThreadDraftGroup[] {
  if (!groups || groups.length === 0) return [];
  return groups
    .flatMap((group) => {
      const activeDrafts = group.drafts.filter(
        (draft) => draft.status === "active" && draftHasReviewContent(draft),
      );
      return activeDrafts.length > 0
        ? [
            {
              ...group,
              drafts: activeDrafts,
            },
          ]
        : [];
    })
    .sort((left, right) => newestUpdatedAt(right) - newestUpdatedAt(left));
}

function newestUpdatedAt(group: ThreadDraftGroup): number {
  return Math.max(...group.drafts.map((draft) => Date.parse(draft.updatedAt) || 0));
}

export function dockedDraftCountKey(groups: readonly ThreadDraftGroup[]): string {
  return groups.map((group) => `${group.documentId}:${group.drafts.length}`).join("|");
}

function draftHasReviewContent(draft: ThreadDraftListItem): boolean {
  const hasKnownOperationCount = typeof draft.proposedOperationCount === "number";
  const hasKnownWordDelta =
    typeof draft.wordsAdded === "number" || typeof draft.wordsRemoved === "number";
  if (!hasKnownOperationCount && !hasKnownWordDelta) return true;
  return (
    (draft.proposedOperationCount ?? 0) > 0 ||
    (draft.wordsAdded ?? 0) > 0 ||
    (draft.wordsRemoved ?? 0) > 0
  );
}
