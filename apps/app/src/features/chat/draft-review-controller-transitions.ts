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
  | ({ kind: "panel" } & DraftReviewSelection)
  | ({ kind: "inline" } & DraftReviewSelection);

export type DraftReviewState = {
  surface: DraftReviewSurface;
  overlap: DraftReviewOverlap | null;
  staleDraft: DraftReviewSelection | null;
  /** Operation ids currently settling, keyed by draft id so one draft cannot block another. */
  pendingDiscardIdsByDraft: ReadonlyMap<string, ReadonlySet<string>>;
  /** The draft currently running a reject operation; rejects serialize only inside that draft. */
  activeDiscardDraftId: string | null;
};

export type DraftReviewAction =
  | { type: "openPanel"; documentId: string; draftId: string; overlap?: DraftReviewOverlap | null }
  | { type: "enterInline"; documentId: string; draftId: string }
  | { type: "applySucceeded"; documentId: string; draftId: string; response: DraftAcceptResponse }
  | { type: "overlapReturned"; documentId: string; overlap: DraftReviewOverlap }
  | { type: "discardStarted"; draftId: string; operationId: string }
  | { type: "discardSettled"; draftId: string; operationId: string }
  | { type: "rejectSucceeded"; draftId: string }
  | { type: "exitPanel" }
  | { type: "exitInline" }
  | { type: "exitReview" }
  | { type: "hardFallbackToPanel"; documentId: string; draftId: string };

export const EMPTY_DRAFT_REVIEW_STATE: DraftReviewState = {
  surface: { kind: "none" },
  overlap: null,
  staleDraft: null,
  pendingDiscardIdsByDraft: new Map(),
  activeDiscardDraftId: null,
};

export function draftReviewReducer(
  state: DraftReviewState,
  action: DraftReviewAction,
): DraftReviewState {
  switch (action.type) {
    case "openPanel":
      return {
        ...state,
        surface: { kind: "panel", documentId: action.documentId, draftId: action.draftId },
        overlap: action.overlap ?? null,
        staleDraft: null,
      };
    case "enterInline":
      return {
        ...state,
        surface: { kind: "inline", documentId: action.documentId, draftId: action.draftId },
        overlap: null,
        staleDraft: null,
      };
    case "applySucceeded":
      return stateAfterAcceptResult(state, action);
    case "overlapReturned":
      return {
        ...state,
        surface: { kind: "panel", documentId: action.documentId, draftId: action.overlap.draftId },
        overlap: action.overlap,
        staleDraft: null,
      };
    case "discardStarted":
      return {
        ...state,
        pendingDiscardIdsByDraft: addPendingDiscard(
          state.pendingDiscardIdsByDraft,
          action.draftId,
          action.operationId,
        ),
        activeDiscardDraftId: action.draftId,
      };
    case "discardSettled":
      return {
        ...state,
        pendingDiscardIdsByDraft: removePendingDiscard(
          state.pendingDiscardIdsByDraft,
          action.draftId,
          action.operationId,
        ),
        activeDiscardDraftId:
          state.activeDiscardDraftId === action.draftId ? null : state.activeDiscardDraftId,
      };
    case "rejectSucceeded":
      return clearDraftReviewState(state, action.draftId);
    case "exitPanel":
      if (state.surface.kind !== "panel") return state;
      return { ...state, surface: { kind: "none" }, overlap: null, staleDraft: null };
    case "exitInline":
      if (state.surface.kind !== "inline") return state;
      return { ...state, surface: { kind: "none" }, overlap: null, staleDraft: null };
    case "exitReview":
      return { ...state, surface: { kind: "none" }, overlap: null, staleDraft: null };
    case "hardFallbackToPanel":
      return {
        ...state,
        surface: { kind: "panel", documentId: action.documentId, draftId: action.draftId },
        overlap: null,
        staleDraft: null,
      };
    default:
      return state;
  }
}

export function acceptIsBlocked(input: {
  isPending: boolean;
  isInlineDiscardPending: boolean;
}): boolean {
  return input.isPending || input.isInlineDiscardPending;
}

export function inlineDiscardIsPending(state: DraftReviewState, draftId?: string | null): boolean {
  if (draftId) return (state.pendingDiscardIdsByDraft.get(draftId)?.size ?? 0) > 0;
  return state.pendingDiscardIdsByDraft.size > 0;
}

export function pendingDiscardIdsForDraft(
  state: DraftReviewState,
  draftId: string | null | undefined,
): ReadonlySet<string> {
  if (!draftId) return EMPTY_SET;
  return state.pendingDiscardIdsByDraft.get(draftId) ?? EMPTY_SET;
}

export function discardCanStart(state: DraftReviewState, draftId: string): boolean {
  return state.activeDiscardDraftId == null || state.activeDiscardDraftId !== draftId;
}

export function selectedDraftFromState(state: DraftReviewState): DraftReviewSelection | null {
  return state.surface.kind === "panel" ? selectionFromSurface(state.surface) : null;
}

export function inlineReviewFromState(state: DraftReviewState): InlineDraftReview | null {
  return state.surface.kind === "inline" ? selectionFromSurface(state.surface) : null;
}

function stateAfterAcceptResult(
  state: DraftReviewState,
  input: { documentId: string; draftId: string; response: DraftAcceptResponse },
): DraftReviewState {
  const { documentId, draftId, response } = input;
  if (response.status === "stale_draft") {
    return {
      ...state,
      surface: { kind: "panel", documentId, draftId: response.draftId },
      overlap: null,
      staleDraft: { documentId, draftId: response.draftId },
    };
  }

  if (response.status === "partial_applied") {
    return { ...state, overlap: null, staleDraft: null };
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
  };
}

function selectionFromSurface(surface: Extract<DraftReviewSurface, { kind: "panel" | "inline" }>) {
  return { documentId: surface.documentId, draftId: surface.draftId };
}

function addPendingDiscard(
  pending: ReadonlyMap<string, ReadonlySet<string>>,
  draftId: string,
  operationId: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const current = pending.get(draftId) ?? EMPTY_SET;
  if (current.has(operationId)) return pending;
  const next = new Map(pending);
  next.set(draftId, new Set([...current, operationId]));
  return next;
}

function removePendingDiscard(
  pending: ReadonlyMap<string, ReadonlySet<string>>,
  draftId: string,
  operationId: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const current = pending.get(draftId);
  if (!current?.has(operationId)) return pending;
  const nextDraftSet = new Set(current);
  nextDraftSet.delete(operationId);
  const next = new Map(pending);
  if (nextDraftSet.size === 0) next.delete(draftId);
  else next.set(draftId, nextDraftSet);
  return next;
}

const EMPTY_SET = new Set<string>();
