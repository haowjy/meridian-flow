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
    const draft = active[0] ?? visible[0];
    if (!draft) continue;
    rows.push({
      documentId: group.documentId,
      documentName: group.documentName,
      contextPath: group.contextPath,
      draft,
      state: draft.status === "active" ? "pending" : "reviewed",
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

/** Groups that still carry an active draft — the dock exists iff this is non-empty. */
export function activeDockedDraftGroups(
  groups: ThreadDraftGroup[] | null | undefined,
): ThreadDraftGroup[] {
  if (!groups || groups.length === 0) return [];
  return groups
    .flatMap((group) => {
      const activeDrafts = group.drafts.filter((draft) => draft.status === "active");
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
