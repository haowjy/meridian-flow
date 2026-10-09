/**
 * useFinishedReviewReentry — a review on "No changes left" takes up its draft's
 * next proposal in place.
 *
 * The server closes a draft by resetting its branch, and the same draft id
 * carries the next proposal (a new generation, a new review room). The closed
 * review stays open on that id, joined to a room that is now dead, and nothing
 * refreshes it: the strip and the Work page learn of the proposal through the
 * Work's draft list, which this hook watches on the review's behalf.
 *
 * A list row for the draft that differs from the one the review closed on is
 * only a hint. A list read that started before the close can still list the
 * draft, so the row never reopens the review; it makes the review read the
 * draft's preview afresh (cancelling any read already in flight, which may
 * predate the close), and only that read, which began after the closing answer
 * and so describes the server as it is now, decides. The review re-enters when
 * it lists changes, the way entering a review does (fresh preview and room,
 * completion cleared). A read that lists none leaves "No changes left" alone
 * until the row changes again.
 */

import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { workDraftsQueryOptions } from "@/client/query/useWorkDrafts";
import type { InlineDraftReview } from "./draft-review-session";
import { reviewChangesOfPreview } from "./review-changes";

export function useFinishedReviewReentry({
  projectId,
  workId,
  inlineReview,
  reenter,
}: {
  projectId: string;
  workId: string;
  inlineReview: InlineDraftReview | null;
  /** Re-enter the finished review (a no-op unless it is still closed on that draft). */
  reenter: (documentId: string, draftId: string) => void;
}): void {
  const queryClient = useQueryClient();
  const documentId = inlineReview?.documentId ?? null;
  const draftId = inlineReview?.draftId ?? null;
  const closed = inlineReview?.completion?.phase === "closed";
  const closedKey = closed && documentId && draftId ? `${documentId}\u0000${draftId}` : null;

  // The draft's list row version, read only while its review is finished.
  const { data: listedAt = null } = useQuery({
    ...workDraftsQueryOptions(projectId, workId),
    enabled: closedKey !== null && Boolean(projectId) && Boolean(workId),
    select: (rows) => rows.find((row) => row.draftId === draftId)?.updatedAt ?? null,
  });

  // The row the review closed on, kept so the list catching up with the close
  // (or a stale read of it) is not mistaken for a new proposal.
  const closedOn = useRef<{ key: string; listedAt: string | null } | null>(null);

  useEffect(() => {
    if (!closedKey || !documentId || !draftId) {
      closedOn.current = null;
      return;
    }
    if (closedOn.current?.key !== closedKey) closedOn.current = { key: closedKey, listedAt };
    if (listedAt === null || listedAt === closedOn.current.listedAt) return;

    let current = true;
    const queryKey = projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId);
    void queryClient
      .refetchQueries({ queryKey, exact: true }, { cancelRefetch: true })
      .catch(() => undefined)
      .then(() => {
        if (!current) return;
        // A failed read leaves the cache holding what it held before the close.
        if (queryClient.getQueryState(queryKey)?.status !== "success") return;
        const read = queryClient.getQueryData<DraftPreviewResponse>(queryKey);
        if (
          read?.status === "active" &&
          read.inlineModelPresent &&
          reviewChangesOfPreview(read).length > 0
        )
          reenter(documentId, draftId);
      });
    return () => {
      current = false;
    };
  }, [closedKey, documentId, draftId, listedAt, projectId, workId, queryClient, reenter]);
}
