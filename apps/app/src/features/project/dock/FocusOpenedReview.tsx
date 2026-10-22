/** A launch focuses its clicked group only while the same projection still paints. */
import { useEffect, useRef } from "react";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { type ReviewFocus, resolveFocusedChange } from "@/features/draft-review/review-model";
import { useOpenReviewChanges } from "@/features/draft-review/useOpenReviewChanges";

export type ReviewFocusRequest = {
  /** The launch that made it; a newer launch replaces the request. */
  sequence: number;
  documentId: string;
  itemKey: string;
  focus: ReviewFocus;
};

export function FocusOpenedReview({
  request,
  onDone,
}: {
  request: ReviewFocusRequest;
  onDone: () => void;
}) {
  const { controller } = useDraftReview();
  const { status, changes } = useOpenReviewChanges(controller);
  // Set once the requested review has been the open one: leaving it ends the request.
  const entered = useRef(false);

  useEffect(() => {
    const open = controller.inlineReview;
    if (open?.documentId !== request.documentId || open.itemKey !== request.itemKey) {
      if (entered.current) onDone();
      return;
    }
    entered.current = true;
    if (!open.shown) return;
    if (status === "gone") return onDone();
    if (status !== "ready") return;
    const change = resolveFocusedChange(changes, request.focus);
    if (change) {
      const { documentId, itemKey } = request;
      controller.focusReviewChange({ documentId, itemKey }, change, { scroll: true });
    }
    onDone();
  }, [status, changes, controller, onDone, request]);

  return null;
}
