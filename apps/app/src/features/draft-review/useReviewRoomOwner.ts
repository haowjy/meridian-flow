/** Review room binding while B2 replaces settlement-era command ownership. */
import type { Dispatch } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import type { DraftPreviewRead } from "@/client/query/useDraftPreview";
import type { DraftReviewAction, InlineDraftReview } from "./draft-review-session";

export function useReviewRoomOwner(_input: {
  projectId: string;
  workId: string;
  review: InlineDraftReview | null;
  dispatch: Dispatch<DraftReviewAction>;
  disposing: boolean;
  presented?: unknown;
}) {
  return {
    session: null as DocumentSession | null,
    carryPending: false,
    reopen: () => undefined,
    inputEligible: false,
  } as const;
}

export function reviewRoomObservations(
  _rows: import("@meridian/contracts/branches").ThreadDraftListItem[] | undefined,
  _preview: DraftPreviewRead | undefined,
  _draft: { documentId: string; itemKey: string },
): DraftReviewAction[] {
  return [];
}
export type ReviewRoomOwner = ReturnType<typeof useReviewRoomOwner>;
