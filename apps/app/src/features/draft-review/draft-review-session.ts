/** Review presentation owns only the selected document, focus and chrome. Text and commands have other owners. */
import type { ReviewFocus } from "./review-model";
export type DraftItemRef = { documentId: string; itemKey: string };
export type InlineDraftReview = DraftItemRef & {
  kind: "inline";
  focus?: ReviewFocus | null;
  shown?: boolean;
};
type DraftReviewState = {
  surface: { kind: "none" } | InlineDraftReview;
};
type DraftReviewAction =
  | (DraftItemRef & { type: "enterInline" })
  | (DraftItemRef & { type: "inlineShown"; shown: boolean })
  | (DraftItemRef & { type: "changeFocused"; focus: ReviewFocus | null })
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
      return review.focus?.id === action.focus?.id
        ? state
        : { ...state, surface: { ...review, focus: action.focus } };
  }
}
const matches = (a: DraftItemRef, b: DraftItemRef) =>
  a.documentId === b.documentId && a.itemKey === b.itemKey;
export const inlineReviewFromState = (state: DraftReviewState) =>
  state.surface.kind === "inline" ? state.surface : null;
