/**
 * FocusOpenedReview: opens a review on a given change.
 *
 * A launch that names changes (`focusChangeIds`) makes the Editor scope's claimant mount this once it has
 * entered the review. It applies the request once, when the review it names is the open one, has painted
 * (`inlineReview.shown`) and has its projection: the first named change that still exists is focused and
 * scrolled to. A review that is not the one requested (the one being left, still painted during the
 * handover) is never focused. If none of the changes exists any more (a change's id is a hash of its
 * text, so an edit renames it) the review stays at the top, as a launch without a focus does. Mounted
 * only while a request is pending.
 */
import { useEffect, useRef } from "react";

import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { useOpenReviewChanges } from "@/features/draft-review/useOpenReviewChanges";

export type ReviewFocusRequest = {
  /** The launch that made it; a newer launch replaces the request. */
  sequence: number;
  documentId: string;
  itemKey: string;
  changeIds: readonly string[];
};

export function FocusOpenedReview({
  request,
  onDone,
}: {
  request: ReviewFocusRequest;
  onDone: () => void;
}) {
  const { controller } = useDraftReview();
  const { changes, status } = useOpenReviewChanges(controller);
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
    if (status === "error" || status === "gone") return onDone();
    if (status !== "ready") return;
    const wanted = new Set(request.changeIds);
    const change = changes.find((candidate) => wanted.has(candidate.id));
    if (change) {
      const { documentId, itemKey } = request;
      controller.focusReviewChange({ documentId, itemKey }, change.id, { scroll: true });
    }
    onDone();
  }, [changes, controller, onDone, request, status]);

  return null;
}
