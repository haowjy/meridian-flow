/** draft-review-controller-transitions — pure state machine for draft review sessions. */
import type { DraftAcceptResponse } from "@meridian/contracts/drafts";

export type DraftReviewSelection = {
  documentId: string;
  draftId: string;
};

export type InlineDraftReview = DraftReviewSelection;

export type DraftReviewOverlap = {
  draftId: string;
  liveRevisionToken?: number;
  live?: string;
  preview?: string;
};

export type DraftReviewSurface =
  | { kind: "none" }
  | ({ kind: "inline"; previewIdentity?: string } & DraftReviewSelection);

type CannotPlaceDraft = DraftReviewSelection & { identity: string | null };

export type DraftReviewState = {
  surface: DraftReviewSurface;
  overlap: DraftReviewOverlap | null;
  staleDraft: DraftReviewSelection | null;
  /** Whole-draft accept that hit terminal placement failure during the inline session. */
  cannotPlaceDraft: CannotPlaceDraft | null;
};

export type DraftReviewAction =
  | { type: "enterInline"; documentId: string; draftId: string }
  | { type: "inlineModelAvailable"; documentId: string; draftId: string; identity: string }
  | { type: "applySucceeded"; documentId: string; draftId: string; response: DraftAcceptResponse }
  | { type: "overlapReturned"; documentId: string; overlap: DraftReviewOverlap }
  | { type: "rejectSucceeded"; draftId: string }
  | { type: "exitInline" }
  | { type: "exitReview" };

export const EMPTY_DRAFT_REVIEW_STATE: DraftReviewState = {
  surface: { kind: "none" },
  overlap: null,
  staleDraft: null,
  cannotPlaceDraft: null,
};

export function draftReviewReducer(
  state: DraftReviewState,
  action: DraftReviewAction,
): DraftReviewState {
  switch (action.type) {
    case "enterInline":
      return {
        ...state,
        surface: inlineSurfaceForEnter(state.surface, action),
        overlap: null,
        staleDraft: null,
        cannotPlaceDraft: selectionMatches(state.cannotPlaceDraft, action)
          ? state.cannotPlaceDraft
          : null,
      };
    case "inlineModelAvailable":
      return stateAfterInlineModelAvailable(state, action);
    case "applySucceeded":
      return stateAfterAcceptResult(state, action);
    case "overlapReturned":
      return {
        ...state,
        surface: { kind: "inline", documentId: action.documentId, draftId: action.overlap.draftId },
        overlap: action.overlap,
        staleDraft: null,
        // An overlap response proves the draft is placeable — not terminal.
        cannotPlaceDraft: null,
      };
    case "rejectSucceeded":
      return clearDraftReviewState(state, action.draftId);
    case "exitInline":
      if (state.surface.kind !== "inline") return state;
      return {
        ...state,
        surface: { kind: "none" },
        overlap: null,
        staleDraft: null,
        cannotPlaceDraft: null,
      };
    case "exitReview":
      return {
        ...state,
        surface: { kind: "none" },
        overlap: null,
        staleDraft: null,
        cannotPlaceDraft: null,
      };
    default:
      return state;
  }
}

export function acceptIsBlocked(input: {
  isPending: boolean;
  isCannotPlaceTerminal?: boolean;
}): boolean {
  return input.isPending || input.isCannotPlaceTerminal === true;
}

export function inlineReviewFromState(state: DraftReviewState): InlineDraftReview | null {
  return state.surface.kind === "inline" ? selectionFromSurface(state.surface) : null;
}

function inlineSurfaceForEnter(
  current: DraftReviewSurface,
  selection: DraftReviewSelection,
): DraftReviewSurface {
  if (surfaceMatchesDraft(current, selection)) return current;
  return { kind: "inline", documentId: selection.documentId, draftId: selection.draftId };
}

function stateAfterAcceptResult(
  state: DraftReviewState,
  input: { documentId: string; draftId: string; response: DraftAcceptResponse },
): DraftReviewState {
  const { documentId, draftId, response } = input;
  if (response.status === "stale_draft" || response.status === "causal_dependency") {
    return {
      ...state,
      surface: { kind: "inline", documentId, draftId: response.draftId },
      overlap: null,
      staleDraft: { documentId, draftId: response.draftId },
      cannotPlaceDraft: null,
    };
  }

  if (response.status === "cannot_place") {
    return {
      ...state,
      surface: { kind: "inline", documentId, draftId: response.draftId },
      overlap: null,
      staleDraft: null,
      cannotPlaceDraft: {
        documentId,
        draftId: response.draftId,
        identity:
          state.surface.kind === "inline" &&
          surfaceMatchesDraft(state.surface, { documentId, draftId: response.draftId })
            ? (state.surface.previewIdentity ?? null)
            : null,
      },
    };
  }

  if (response.status === "partial_applied") {
    return {
      ...state,
      overlap: null,
      staleDraft: null,
      cannotPlaceDraft: null,
    };
  }

  if (response.status === "overlap") {
    return draftReviewReducer(state, {
      type: "overlapReturned",
      documentId,
      overlap: {
        draftId: response.draftId,
        liveRevisionToken: response.liveRevisionToken,
        live: response.live,
        preview: response.preview,
      },
    });
  }

  return clearDraftReviewState(state, draftId);
}

function clearDraftReviewState(state: DraftReviewState, draftId: string): DraftReviewState {
  const currentDraftId = state.surface.kind === "none" ? null : state.surface.draftId;
  return {
    ...state,
    surface: currentDraftId === draftId ? { kind: "none" } : state.surface,
    overlap: state.overlap?.draftId === draftId ? null : state.overlap,
    staleDraft: state.staleDraft?.draftId === draftId ? null : state.staleDraft,
    cannotPlaceDraft: state.cannotPlaceDraft?.draftId === draftId ? null : state.cannotPlaceDraft,
  };
}

function stateAfterInlineModelAvailable(
  state: DraftReviewState,
  action: { documentId: string; draftId: string; identity: string },
): DraftReviewState {
  const nextSurface = surfaceMatchesDraft(state.surface, action)
    ? { ...state.surface, previewIdentity: action.identity }
    : state.surface;
  if (
    state.cannotPlaceDraft &&
    selectionMatches(state.cannotPlaceDraft, action) &&
    state.cannotPlaceDraft.identity !== action.identity
  ) {
    return {
      ...state,
      surface: nextSurface,
      cannotPlaceDraft: null,
    };
  }
  return { ...state, surface: nextSurface };
}

function selectionFromSurface(surface: Extract<DraftReviewSurface, { kind: "inline" }>) {
  return { documentId: surface.documentId, draftId: surface.draftId };
}

function surfaceMatchesDraft(
  surface: DraftReviewSurface,
  selection: DraftReviewSelection,
): boolean {
  return surface.kind !== "none" && selectionMatches(surface, selection);
}

function selectionMatches(left: DraftReviewSelection | null, right: DraftReviewSelection): boolean {
  return left?.documentId === right.documentId && left.draftId === right.draftId;
}
