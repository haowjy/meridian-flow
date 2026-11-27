import type { ReviewTarget } from "./project-address";

const REVIEW_OPENED_FROM = "meridianReviewOpenedFrom";

export function reviewOpenedFromMark(documentId: string): Record<string, unknown> {
  return { [REVIEW_OPENED_FROM]: documentId };
}

export function reviewOpenedFrom(state: object): string | null {
  const from = (state as { [REVIEW_OPENED_FROM]?: unknown })[REVIEW_OPENED_FROM];
  return typeof from === "string" ? from : null;
}

export type MainReviewControls = {
  close: () => void;
  focus: (changeId: string) => void;
  retarget: (review: ReviewTarget) => void;
};
