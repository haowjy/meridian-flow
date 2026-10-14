/**
 * State policy for the selected draft review. The review's content (changes, "No changes left") is not
 * stored here: it is a pure function of the draft room's text, read from the projection. This holds only
 * what the writer chose: which draft is open, which change is focused, and whether marks show.
 */

export type DraftReviewSelection = {
  documentId: string;
  itemKey: string;
};

export type InlineDraftReview = {
  kind: "inline";
  /** The browser projection of this draft is available, so the review can be acted on. */
  previewIdentity?: string;
  /** The draft's room could not be resolved; entering the draft again retries. */
  roomError?: boolean;
  /** The change (a review group id) the writer is looking at, if any. One value for the whole review. */
  focus?: string | null;
  /** The review body has painted, so the review chrome may show with it. */
  shown?: boolean;
} & DraftReviewSelection;

export type DraftReviewSurface = { kind: "none" } | InlineDraftReview;

export type DraftReviewState = {
  surface: DraftReviewSurface;
  /** The header's "Show changes": false hides every mark in the manuscript. */
  marksVisible: boolean;
};

export type DraftReviewAction =
  | ({ type: "enterInline" } & DraftReviewSelection)
  | (DraftReviewSelection & { type: "inlineModelAvailable"; identity: string })
  | (DraftReviewSelection & { type: "inlineShown"; shown: boolean })
  | (DraftReviewSelection & { type: "reviewDisposed" })
  | (DraftReviewSelection & { type: "changeFocused"; focus: string | null })
  | (DraftReviewSelection & {
      /** The draft left the Work's list or its metadata says gone. A draft-only document's lifecycle settles it. */
      type: "reviewAbsent";
      draftOnly?: boolean;
    })
  | (DraftReviewSelection & { type: "roomFailed" })
  | { type: "marksVisible"; visible: boolean }
  | { type: "exitInline" }
  | { type: "exitReview" };

export const EMPTY_DRAFT_REVIEW_STATE: DraftReviewState = {
  surface: { kind: "none" },
  marksVisible: true,
};

export function draftReviewReducer(
  state: DraftReviewState,
  action: DraftReviewAction,
): DraftReviewState {
  switch (action.type) {
    case "enterInline": {
      const current = inlineOf(state, action);
      if (current) {
        if (!current.roomError) return state;
        const { roomError: _failed, ...retrying } = current;
        return { ...state, surface: retrying };
      }
      return {
        ...state,
        surface: { kind: "inline", documentId: action.documentId, itemKey: action.itemKey },
      };
    }
    case "inlineModelAvailable": {
      const current = inlineOf(state, action);
      if (!current || current.previewIdentity === action.identity) return state;
      return { ...state, surface: { ...current, previewIdentity: action.identity } };
    }
    case "inlineShown": {
      const current = inlineOf(state, action);
      if (!current || (current.shown ?? false) === action.shown) return state;
      return { ...state, surface: { ...current, shown: action.shown } };
    }
    case "changeFocused": {
      const current = inlineOf(state, action);
      if (!current || (current.focus ?? null) === action.focus) return state;
      return { ...state, surface: { ...current, focus: action.focus } };
    }
    case "roomFailed": {
      const current = inlineOf(state, action);
      return current && !current.roomError
        ? { ...state, surface: { ...current, roomError: true } }
        : state;
    }
    case "reviewAbsent": {
      const current = inlineOf(state, action);
      if (!current) return state;
      if (action.draftOnly) {
        return current.roomError ? state : { ...state, surface: { ...current, roomError: true } };
      }
      return left(state);
    }
    case "reviewDisposed":
      return inlineOf(state, action) ? left(state) : state;
    case "marksVisible":
      return state.marksVisible === action.visible
        ? state
        : { ...state, marksVisible: action.visible };
    case "exitInline":
      return state.surface.kind === "inline" ? left(state) : state;
    case "exitReview":
      return left(state);
    default:
      return state;
  }
}

export function inlineReviewFromState(state: DraftReviewState): InlineDraftReview | null {
  return state.surface.kind === "inline" ? state.surface : null;
}

function inlineOf(state: DraftReviewState, draft: DraftReviewSelection): InlineDraftReview | null {
  const { surface } = state;
  return surface.kind === "inline" &&
    surface.documentId === draft.documentId &&
    surface.itemKey === draft.itemKey
    ? surface
    : null;
}

/** Leaving review: the next review starts with its marks showing. */
function left(state: DraftReviewState): DraftReviewState {
  return { ...state, surface: { kind: "none" }, marksVisible: true };
}
