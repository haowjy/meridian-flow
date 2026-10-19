/** Open review ownership holds a stable room; projection readiness is independent of command delivery. */
import { type Dispatch, useEffect, useSyncExternalStore } from "react";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import type { DraftReviewAction, InlineDraftReview } from "./draft-review-session";
import { useRoomReview } from "./useRoomReview";

export function useReviewRoomOwner(input: {
  projectId: string;
  workId: string;
  review: InlineDraftReview | null;
  dispatch: Dispatch<DraftReviewAction>;
  presented?: unknown;
}) {
  const { review, dispatch } = input;
  const commands = useDraftCommandOwner();
  useSyncExternalStore(commands.subscribe, commands.snapshot, commands.snapshot);
  const command = commands.state(review?.itemKey ?? "");
  useEffect(() => {
    if (!review || (!command.hidden && !command.closed)) return;
    dispatch({ type: "exitInline" });
    if (!command.hidden && command.closed && !command.removed)
      dispatch({
        type: "toast",
        code: "draft-closed",
        tone: "info",
        unsentText: command.unsentText,
      });
  }, [command.hidden, command.closed, review?.itemKey, dispatch]);
  const read = useRoomReview(
    review ? { projectId: input.projectId, workId: input.workId, ...review } : null,
  );
  useEffect(() => {
    if (!review || command.closed) return;
    if (read.roomName)
      dispatch({
        type: "roomResolved",
        documentId: review.documentId,
        itemKey: review.itemKey,
        roomName: read.roomName,
      });
    else if (read.status === "error")
      dispatch({ type: "roomFailed", documentId: review.documentId, itemKey: review.itemKey });
  }, [read.roomName, read.status, command.closed, review?.documentId, review?.itemKey, dispatch]);
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
