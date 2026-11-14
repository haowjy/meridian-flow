/** Open review ownership holds a stable room; projection readiness is independent of command delivery. */
import { type Dispatch, useEffect, useSyncExternalStore } from "react";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import type { DraftReviewAction, InlineDraftReview } from "./draft-review-session";
import { useRoomBindings } from "./useRoomReview";

export function useReviewRoomOwner(input: {
  projectId: string;
  ownerKey: string;
  review: InlineDraftReview | null;
  dispatch: Dispatch<DraftReviewAction>;
}) {
  const { review, dispatch } = input;
  const commands = useDraftCommandOwner();
  // Leaves the review when this tab's own Discard ended it (its notice says so and has the Undo),
  // or its document was removed. A draft discarded anywhere else stays on screen, in Trash.
  const leaves = () => {
    const command = commands.state(review?.itemKey ?? "");
    return command.hidden || (command.closed && (command.closedHere || command.removed));
  };
  const leaving = useSyncExternalStore(commands.subscribe, leaves, leaves);
  useEffect(() => {
    if (review && leaving) dispatch({ type: "exitInline" });
  }, [leaving, review?.itemKey, dispatch]);
  const read = useRoomBindings(
    review
      ? [
          {
            projectId: input.projectId,
            ownerKey: input.ownerKey,
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
