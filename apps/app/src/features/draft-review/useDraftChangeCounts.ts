/**
 * useDraftChangeCounts — how many changes each of the Work's drafts holds, for
 * the draft switcher. The open review's count comes from its own list; the
 * others are read from their previews only while the switcher is open (the
 * server computes each one), through the shared preview query, so opening a
 * draft afterwards finds it already read.
 */
import { useQueries } from "@tanstack/react-query";

import { draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
import { reviewChanges } from "./review-changes";

export function useDraftChangeCounts(
  scope: { projectId: string; workId: string },
  drafts: readonly { documentId: string; draftId: string }[],
  enabled: boolean,
): ReadonlyMap<string, number> {
  const results = useQueries({
    queries: drafts.map((draft) => ({
      ...draftPreviewQueryOptions({ ...scope, ...draft }),
      enabled,
    })),
  });
  const counts = new Map<string, number>();
  results.forEach((result, index) => {
    const preview = result.data;
    if (preview?.status !== "active" || !preview.inlineModelPresent) return;
    counts.set(drafts[index].documentId, reviewChanges(preview.operations, preview.hunks).length);
  });
  return counts;
}
