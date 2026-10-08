/**
 * FocusOpenedReview — opens a review on a given change.
 *
 * A launch that names operations (`focusOperationIds`) makes the Editor scope's
 * claimant mount this once it has entered the review. It applies the request
 * once, when the review it names is the open one, has painted
 * (`inlineReview.shown`) and its preview has loaded: the change holding any of
 * the operations is focused and scrolled to. A review that is not the one
 * requested (the one being left, still painted during the handover) is never
 * focused. If no operation is in the preview any more the review stays at the
 * top, as a launch without a focus does. Mounted only while a request is
 * pending, so no preview is read otherwise.
 */
import { useEffect, useRef } from "react";

import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { useOpenReviewChanges } from "@/features/draft-review/useReviewChanges";

export type ReviewFocusRequest = {
  /** The launch that made it; a newer launch replaces the request. */
  sequence: number;
  documentId: string;
  draftId: string;
  operationIds: readonly string[];
};

export function FocusOpenedReview({
  request,
  onDone,
}: {
  request: ReviewFocusRequest;
  onDone: () => void;
}) {
  const { controller } = useDraftReview();
  const { active, preview, changes } = useOpenReviewChanges(controller);
  // Set once the requested review has been the open one: leaving it ends the request.
  const entered = useRef(false);

  useEffect(() => {
    const open = controller.inlineReview;
    if (open?.documentId !== request.documentId || open.draftId !== request.draftId) {
      if (entered.current) onDone();
      return;
    }
    entered.current = true;
    if (!open.shown) return;
    if (preview?.status === "gone") return onDone();
    if (!active) return;
    const wanted = new Set(request.operationIds);
    const change = changes.find((candidate) =>
      candidate.operationIds.some((operationId) => wanted.has(operationId)),
    );
    if (change) {
      const { documentId, draftId } = request;
      controller.focusReviewChange({ documentId, draftId }, change, { scroll: true });
    }
    onDone();
  }, [active, changes, controller, onDone, preview, request]);

  return null;
}
