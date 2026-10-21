/** Open review ownership holds a stable room; projection readiness is independent of command delivery. */
import { type Dispatch, useEffect, useSyncExternalStore } from "react";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import type { DraftReviewAction, InlineDraftReview } from "./draft-review-session";
import { useRoomBindings } from "./useRoomReview";

export function useReviewRoomOwner(input: {
  projectId: string;
  workId: string;
  review: InlineDraftReview | null;
  dispatch: Dispatch<DraftReviewAction>;
  presented?: unknown;
}) {
  const { review, dispatch } = input;
  const commands = useDraftCommandOwner();
  const hidden = () => commands.state(review?.itemKey ?? "").hidden;
  const closed = () => commands.state(review?.itemKey ?? "").closed;
  useSyncExternalStore(commands.subscribe, hidden, hidden);
  useSyncExternalStore(commands.subscribe, closed, closed);
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
  const read = useRoomBindings(
    review
      ? [
          {
            projectId: input.projectId,
            workId: input.workId,
            documentId: review.documentId,
            itemKey: review.itemKey,
          },
        ]
      : [],
  )[0];
  return {
    session: read?.session ?? null,
    roomName: read?.roomName ?? null,
    runtime: read?.runtime ?? null,
    reopen: read?.retry ?? (() => {}),
    inputEligible: read?.usable != null,
    error: read?.status === "error",
  };
}
export type ReviewRoomOwner = ReturnType<typeof useReviewRoomOwner>;
