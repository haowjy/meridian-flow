/** Review presentation owns only the selected document, focus and chrome. Text and commands have other owners. */
import type { ReviewFocus } from "./review-model";
export type DraftReviewSelection = { documentId: string; itemKey: string };
export type InlineDraftReview = DraftReviewSelection & {
  kind: "inline";
  focus?: ReviewFocus | null;
  shown?: boolean;
};
export type ReviewToastCode = "change-gone" | "draft-closed";
export type ReviewToast = {
  id: number;
  code: ReviewToastCode;
  tone: "info" | "error";
  unsentText?: string | null;
};
export type DraftReviewState = {
  surface: { kind: "none" } | InlineDraftReview;
  marksVisible: boolean;
  toast: ReviewToast | null;
  toastSeq: number;
};
export type DraftReviewAction =
  | (DraftReviewSelection & { type: "enterInline" })
  | (DraftReviewSelection & { type: "inlineShown"; shown: boolean })
  | (DraftReviewSelection & { type: "changeFocused"; focus: ReviewFocus | null })
  | { type: "marksVisible"; visible: boolean }
  | { type: "toast"; code: ReviewToastCode; tone: "info" | "error"; unsentText?: string | null }
  | { type: "toastDismissed"; id: number }
  | { type: "exitInline" | "exitReview" };
export const EMPTY_DRAFT_REVIEW_STATE: DraftReviewState = {
  surface: { kind: "none" },
  marksVisible: true,
  toast: null,
  toastSeq: 0,
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
      return { ...state, surface: { kind: "none" }, marksVisible: true };
    case "marksVisible":
      return state.marksVisible === action.visible
        ? state
        : { ...state, marksVisible: action.visible };
    case "toast":
      return {
        ...state,
        toastSeq: state.toastSeq + 1,
        toast: {
          id: state.toastSeq + 1,
          code: action.code,
          tone: action.tone,
          unsentText: action.unsentText,
        },
      };
    case "toastDismissed":
      return state.toast?.id === action.id ? { ...state, toast: null } : state;
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
