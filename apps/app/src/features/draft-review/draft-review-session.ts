/** Review presentation owns only the selected document, focus and chrome. Text and commands have other owners. */
import type { ReviewFocus } from "./review-model";
export type DraftReviewSelection = { documentId: string; itemKey: string };
export type InlineDraftReview = DraftReviewSelection & {
  kind: "inline";
  focus?: ReviewFocus | null;
  shown?: boolean;
};
export type DraftReviewState = {
  surface: { kind: "none" } | InlineDraftReview;
};
export type DraftReviewAction =
  | (DraftReviewSelection & { type: "enterInline" })
  | (DraftReviewSelection & { type: "inlineShown"; shown: boolean })
  | (DraftReviewSelection & { type: "changeFocused"; focus: ReviewFocus | null })
  | { type: "exitInline" | "exitReview" };
export const EMPTY_DRAFT_REVIEW_STATE: DraftReviewState = {
  surface: { kind: "none" },
};
export function draftReviewReducer(
  state: DraftReviewState,
  action: DraftReviewAction,
): DraftReviewState {
  switch (action.type) {
    case "enterInline":
      if (state.surface.kind === "inline" && matches(state.surface, action)) return state;
      return {
        ...state,
        surface: { kind: "inline", documentId: action.documentId, itemKey: action.itemKey },
      };
    case "exitInline":
    case "exitReview":
      return { ...state, surface: { kind: "none" } };
  }
  const review = state.surface;
  if (review.kind !== "inline" || !matches(review, action)) return state;
  switch (action.type) {
    case "inlineShown":
      return review.shown === action.shown
        ? state
        : { ...state, surface: { ...review, shown: action.shown } };
    case "changeFocused":
      return review.focus?.id === action.focus?.id && review.focus?.frame === action.focus?.frame
        ? state
        : { ...state, surface: { ...review, focus: action.focus } };
  }
}
const matches = (a: DraftReviewSelection, b: DraftReviewSelection) =>
  a.documentId === b.documentId && a.itemKey === b.itemKey;
export const inlineReviewFromState = (state: DraftReviewState) =>
  state.surface.kind === "inline" ? state.surface : null;
