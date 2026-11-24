import type { ReviewTarget } from "./project-address";

/**
 * The history-state key a Review changes entry carries: the document whose plain page it was pushed
 * from. Closing goes Back to that page when the entry still shows that document; otherwise it
 * replaces.
 */
const REVIEW_OPENED_FROM = "meridianReviewOpenedFrom";

/** The history-state mark a Review changes push carries. */
export function reviewOpenedFromMark(documentId: string): Record<string, unknown> {
  return { [REVIEW_OPENED_FROM]: documentId };
}

/** The document whose plain page this Review changes entry was pushed from, if it was. */
export function reviewOpenedFrom(state: object): string | null {
  const from = (state as { [REVIEW_OPENED_FROM]?: unknown })[REVIEW_OPENED_FROM];
  return typeof from === "string" ? from : null;
}

/** What moves main's Review changes: each replaces the review's entry, never pushes. */
export type MainReviewControls = {
  /** Back to the plain draft of the chapter on screen. */
  close: () => void;
  /** The change in focus; the address carries it so a copied link opens there. */
  focus: (changeId: string) => void;
  /** Compare against another reference. */
  retarget: (review: ReviewTarget) => void;
};
