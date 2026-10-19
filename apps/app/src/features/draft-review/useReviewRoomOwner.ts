/** Open review ownership holds a stable room; projection readiness is independent of command delivery. */
import { type Dispatch, useEffect } from "react";
import type { DraftReviewAction, InlineDraftReview } from "./draft-review-session";
import { useRoomReview } from "./useRoomReview";

export function useReviewRoomOwner(input: {
  projectId: string;
  workId: string;
  review: InlineDraftReview | null;
  dispatch: Dispatch<DraftReviewAction>;
  disposing: boolean;
  presented?: unknown;
}) {
  const { review, dispatch } = input;
  const read = useRoomReview(
    review ? { projectId: input.projectId, workId: input.workId, ...review } : null,
  );
  useEffect(() => {
    if (!review) return;
    if (read.roomName)
      dispatch({
        type: "roomResolved",
        documentId: review.documentId,
        itemKey: review.itemKey,
        roomName: read.roomName,
      });
    else if (read.status === "error" || read.status === "gone")
      dispatch({ type: "roomFailed", documentId: review.documentId, itemKey: review.itemKey });
  }, [read.roomName, read.status, review?.documentId, review?.itemKey, dispatch]);
  return {
    session: read.session,
    roomName: read.roomName,
    runtime: read.runtime,
    reopen: read.retry,
    inputEligible: read.usable !== null,
    carryPending: false,
  };
}
export type ReviewRoomOwner = ReturnType<typeof useReviewRoomOwner>;
