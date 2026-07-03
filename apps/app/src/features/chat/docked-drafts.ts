/** docked-drafts — pure assembly rules for the composer draft slot. */
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";

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
