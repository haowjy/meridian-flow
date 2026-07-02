/** draft-review-controller-transitions — pure state transitions for draft review surfaces. */
import type { DraftAcceptResponse } from "@meridian/contracts/drafts";

import type {
  DraftReviewOverlap,
  DraftReviewSelection,
  InlineDraftReview,
} from "./useDraftReviewController";

export type DraftReviewSurfaceState = {
  selectedDraft: DraftReviewSelection | null;
  inlineReview: InlineDraftReview | null;
  overlap: DraftReviewOverlap | null;
};

export function acceptIsBlocked(input: {
  isPending: boolean;
  isInlineDiscardPending: boolean;
}): boolean {
  return input.isPending || input.isInlineDiscardPending;
}

export function stateAfterAcceptResult(
  state: DraftReviewSurfaceState,
  input: { documentId: string; draftId: string; response: DraftAcceptResponse },
): DraftReviewSurfaceState {
  const { documentId, draftId, response } = input;
  if (response.status === "overlap") {
    return {
      selectedDraft: { documentId, draftId: response.draftId },
      inlineReview: clearMatchingSelection(state.inlineReview, response.draftId),
      overlap: {
        draftId: response.draftId,
        liveRevisionToken: response.liveRevisionToken,
        live: response.live,
        preview: response.preview,
      },
    };
  }

  return clearDraftReviewState(state, draftId);
}

export function stateAfterRejectSuccess(
  state: DraftReviewSurfaceState,
  draftId: string,
): DraftReviewSurfaceState {
  return clearDraftReviewState(state, draftId);
}

function clearDraftReviewState(
  state: DraftReviewSurfaceState,
  draftId: string,
): DraftReviewSurfaceState {
  return {
    selectedDraft: clearMatchingSelection(state.selectedDraft, draftId),
    inlineReview: clearMatchingSelection(state.inlineReview, draftId),
    overlap: state.overlap?.draftId === draftId ? null : state.overlap,
  };
}

function clearMatchingSelection<T extends DraftReviewSelection | null>(
  selection: T,
  draftId: string,
): T | null {
  return selection?.draftId === draftId ? null : selection;
}
