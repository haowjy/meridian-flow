/**
 * What a Copy of a document under review reads. The draft is the owner's: the server finds it by
 * owner and document, so no chat is named and none can be the wrong one.
 */
import type { DraftOwnerKey } from "@meridian/contracts/branches";
import type { CopyContextEntryView } from "@meridian/contracts/protocol";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { useDraftReview } from "./DraftReviewProvider";

/**
 * The draft of `ownerKey` for this change, or null when it has no text to copy: a document the
 * draft created is no placed entry yet, and a tree-only change has no draft text.
 */
export function draftCopyView(
  file: ReviewFileTarget,
  ownerKey: string,
): CopyContextEntryView | null {
  return file.draft.hasDraft && !file.draftOnly
    ? { kind: "draft", owner: ownerKey as DraftOwnerKey }
    : null;
}

/**
 * Whether this document's tab is under review, and what a Copy of it reads then (null when the
 * draft has no text to copy).
 */
export function useReviewCopy(documentId: string): {
  reviewing: boolean;
  view: CopyContextEntryView | null;
} {
  const { controller, fileForDocument } = useDraftReview();
  const review = controller.inlineReview;
  const reviewing = review?.documentId === documentId && review.shown === true;
  const file = reviewing ? fileForDocument(documentId) : null;
  return { reviewing, view: file ? draftCopyView(file, controller.ownerKey) : null };
}
