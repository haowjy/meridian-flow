/** draft-review-controller-transitions — pure state machine for draft review sessions. */
import type { DraftAcceptResponse } from "@meridian/contracts/drafts";

export type DraftReviewSelection = {
  documentId: string;
  draftId: string;
};

export type InlineDraftReview = DraftReviewSelection;

export type DraftReviewOverlap = {
  draftId: string;
  /** Present when the overlap confirmation belongs to one inline operation accept. */
  operationId?: string;
  liveRevisionToken?: number;
  live?: string;
  preview?: string;
};

/**
 * Stable identifiers for every writer-facing review message. The controller is
 * a state machine and must not carry localized copy; it emits a code and the
 * render layer (`DockChangesView`) turns it into Lingui text. Keep this the
 * single source of message identity for both accept messages and discard errors.
 */
export type InlineReviewMessageCode =
  | "open-review-first"
  | "change-moved"
  | "apply-failed"
  | "change-applied"
  | "changes-moved-refreshed"
  | "apply-dependencies-first"
  | "change-cannot-place"
  | "changes-moved-confirm-again"
  | "draft-cannot-place"
  | "discard-stale"
  | "discard-finalized"
  | "discard-offline"
  | "discard-failed"
  | "discard-not-settled"
  | "change-restored"
  | "undo-failed";

export type InlineReviewMessage = {
  code: InlineReviewMessageCode;
  tone?: "info" | "error";
  /**
   * The write id a per-card Apply produced (`partial_applied`), which the
   * "Change applied — Undo" affordance reverses. Present only on the
   * `change-applied` message.
   */
  writeId?: string;
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
  /** Operation ids currently settling, keyed by draft id so one draft cannot block another. */
  pendingDiscardIdsByDraft: ReadonlyMap<string, ReadonlySet<string>>;
  /** The draft currently running a reject operation; rejects serialize only inside that draft. */
  activeDiscardDraftId: string | null;
  /**
   * The operation whose per-card Apply is in flight — from the click through the
   * mutation's terminal response. Drives the "disable both verbs on the in-flight
   * card only" affordance; only one accept runs at a time.
   */
  acceptingOperationId: string | null;
  confirmingAcceptOperationId: string | null;
  confirmingDiscardOperationId: string | null;
  /** Per-operation accepts that hit terminal placement failure and now render as dead cards. */
  cannotPlaceOperationIdsByDraft: ReadonlyMap<string, ReadonlySet<string>>;
  inlineReviewMessage: InlineReviewMessage | null;
  inlineDiscardError: InlineReviewMessageCode | null;
};

export type DraftReviewAction =
  | { type: "enterInline"; documentId: string; draftId: string }
  | { type: "inlineModelAvailable"; documentId: string; draftId: string; identity: string }
  | { type: "applySucceeded"; documentId: string; draftId: string; response: DraftAcceptResponse }
  | { type: "overlapReturned"; documentId: string; overlap: DraftReviewOverlap }
  | {
      type: "operationOverlapReturned";
      documentId: string;
      overlap: DraftReviewOverlap & { operationId: string };
    }
  | { type: "confirmAcceptOperation"; operationId: string }
  | { type: "cancelAcceptOperation" }
  | { type: "confirmDiscardOperation"; operationId: string }
  | { type: "cancelDiscardOperation" }
  | { type: "operationAcceptStarted"; operationId: string }
  | { type: "operationAcceptSucceeded"; message: InlineReviewMessage }
  | {
      type: "operationCannotPlace";
      draftId: string;
      operationId: string;
      message: InlineReviewMessage;
    }
  | { type: "operationAcceptFailed"; message: InlineReviewMessage }
  | { type: "operationUndoAcceptSucceeded"; message: InlineReviewMessage }
  | { type: "operationUndoAcceptFailed"; message: InlineReviewMessage }
  | { type: "discardStarted"; draftId: string; operationId: string }
  | { type: "discardSettled"; draftId: string; operationId: string }
  | { type: "discardFailed"; draftId: string; operationId: string; code: InlineReviewMessageCode }
  | { type: "rejectSucceeded"; draftId: string }
  | { type: "exitInline" }
  | { type: "exitReview" };

export const EMPTY_DRAFT_REVIEW_STATE: DraftReviewState = {
  surface: { kind: "none" },
  overlap: null,
  staleDraft: null,
  cannotPlaceDraft: null,
  pendingDiscardIdsByDraft: new Map(),
  activeDiscardDraftId: null,
  acceptingOperationId: null,
  confirmingAcceptOperationId: null,
  confirmingDiscardOperationId: null,
  cannotPlaceOperationIdsByDraft: new Map(),
  inlineReviewMessage: null,
  inlineDiscardError: null,
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
        confirmingAcceptOperationId: null,
        confirmingDiscardOperationId: null,
        inlineReviewMessage: selectionMatches(state.cannotPlaceDraft, action)
          ? state.inlineReviewMessage
          : null,
        inlineDiscardError: null,
      };
    case "inlineModelAvailable":
      return stateAfterInlineModelAvailable(state, action);
    case "applySucceeded":
      return { ...stateAfterAcceptResult(state, action), acceptingOperationId: null };
    case "overlapReturned":
      return {
        ...state,
        surface: { kind: "inline", documentId: action.documentId, draftId: action.overlap.draftId },
        overlap: action.overlap,
        staleDraft: null,
        // An overlap response proves the draft is placeable — not terminal.
        cannotPlaceDraft: null,
      };
    case "operationOverlapReturned":
      return {
        ...state,
        surface: { kind: "inline", documentId: action.documentId, draftId: action.overlap.draftId },
        overlap: action.overlap,
        staleDraft: null,
        cannotPlaceDraft: null,
        acceptingOperationId: null,
        confirmingAcceptOperationId: action.overlap.operationId,
        inlineReviewMessage: null,
      };
    case "confirmAcceptOperation":
      return {
        ...state,
        acceptingOperationId: null,
        confirmingAcceptOperationId: action.operationId,
      };
    case "cancelAcceptOperation":
      return {
        ...state,
        confirmingAcceptOperationId: null,
        overlap: state.overlap?.operationId ? null : state.overlap,
      };
    case "confirmDiscardOperation":
      return { ...state, confirmingDiscardOperationId: action.operationId };
    case "cancelDiscardOperation":
      return { ...state, confirmingDiscardOperationId: null };
    case "operationAcceptStarted":
      // A start can't preempt an accept already in flight — the in-flight one
      // owns `acceptingOperationId` until it terminates. (The controller also
      // guards on the mutation's pending state; this keeps the reducer honest
      // if a second start ever reaches it.)
      if (state.acceptingOperationId) return state;
      return {
        ...state,
        acceptingOperationId: action.operationId,
        confirmingAcceptOperationId: null,
        inlineReviewMessage: null,
        overlap: null,
      };
    case "operationAcceptSucceeded":
      return { ...state, acceptingOperationId: null, inlineReviewMessage: action.message };
    case "operationCannotPlace":
      return {
        ...state,
        acceptingOperationId: null,
        inlineReviewMessage: action.message,
        cannotPlaceOperationIdsByDraft: addOperationId(
          state.cannotPlaceOperationIdsByDraft,
          action.draftId,
          action.operationId,
        ),
      };
    case "operationAcceptFailed":
      return { ...state, acceptingOperationId: null, inlineReviewMessage: action.message };
    case "operationUndoAcceptSucceeded":
    case "operationUndoAcceptFailed":
      return { ...state, inlineReviewMessage: action.message };
    case "discardStarted":
      return {
        ...state,
        confirmingDiscardOperationId: null,
        inlineDiscardError: null,
        pendingDiscardIdsByDraft: addPendingDiscard(
          state.pendingDiscardIdsByDraft,
          action.draftId,
          action.operationId,
        ),
        activeDiscardDraftId: action.draftId,
      };
    case "discardSettled":
      return settleDiscard(state, action.draftId, action.operationId, null);
    case "discardFailed":
      return settleDiscard(state, action.draftId, action.operationId, action.code);
    case "rejectSucceeded":
      return clearDraftReviewState(state, action.draftId);
    case "exitInline":
      if (state.surface.kind !== "inline") return state;
      return clearInlineState({
        ...state,
        surface: { kind: "none" },
        overlap: null,
        staleDraft: null,
        cannotPlaceDraft: null,
      });
    case "exitReview":
      return clearInlineState({
        ...state,
        surface: { kind: "none" },
        overlap: null,
        staleDraft: null,
        cannotPlaceDraft: null,
      });
    default:
      return state;
  }
}

export function acceptIsBlocked(input: {
  isPending: boolean;
  isInlineDiscardPending: boolean;
  isOperationAccepting?: boolean;
  isOperationUndoing?: boolean;
  isCannotPlaceTerminal?: boolean;
}): boolean {
  return (
    input.isPending ||
    input.isInlineDiscardPending ||
    input.isOperationAccepting === true ||
    input.isOperationUndoing === true ||
    input.isCannotPlaceTerminal === true
  );
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

export function cannotPlaceOperationIdsForDraft(
  state: DraftReviewState,
  draftId: string | null | undefined,
): ReadonlySet<string> {
  if (!draftId) return EMPTY_SET;
  return state.cannotPlaceOperationIdsByDraft.get(draftId) ?? EMPTY_SET;
}

export function pendingDiscardIdsMissingFromModel(
  state: DraftReviewState,
  draftId: string,
  modelOperationIds: readonly string[],
): string[] {
  const pending = pendingDiscardIdsForDraft(state, draftId);
  if (pending.size === 0) return [];
  const present = new Set(modelOperationIds);
  return [...pending].filter((operationId) => !present.has(operationId));
}

export function pendingDiscardIdsSettledByPreview(
  state: DraftReviewState,
  input: { documentId: string; draftId: string; operationIds?: readonly string[] },
): string[] {
  if (!surfaceMatchesDraft(state.surface, input)) return [];
  if (!input.operationIds) return [];
  return pendingDiscardIdsMissingFromModel(state, input.draftId, input.operationIds);
}

export function discardCanStart(state: DraftReviewState, draftId: string): boolean {
  return state.activeDiscardDraftId == null || state.activeDiscardDraftId !== draftId;
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
      inlineReviewMessage: { code: "draft-cannot-place", tone: "info" },
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
      inlineReviewMessage: null,
    };
  }
  return { ...state, surface: nextSurface };
}

function clearInlineState(state: DraftReviewState): DraftReviewState {
  return {
    ...state,
    acceptingOperationId: null,
    confirmingAcceptOperationId: null,
    confirmingDiscardOperationId: null,
    inlineReviewMessage: null,
    inlineDiscardError: null,
  };
}

function settleDiscard(
  state: DraftReviewState,
  draftId: string,
  operationId: string,
  error: InlineReviewMessageCode | null,
): DraftReviewState {
  return {
    ...state,
    pendingDiscardIdsByDraft: removePendingDiscard(
      state.pendingDiscardIdsByDraft,
      draftId,
      operationId,
    ),
    activeDiscardDraftId:
      state.activeDiscardDraftId === draftId ? null : state.activeDiscardDraftId,
    cannotPlaceOperationIdsByDraft:
      error == null
        ? removeOperationId(state.cannotPlaceOperationIdsByDraft, draftId, operationId)
        : state.cannotPlaceOperationIdsByDraft,
    inlineDiscardError: error,
  };
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

function addOperationId(
  operationIdsByDraft: ReadonlyMap<string, ReadonlySet<string>>,
  draftId: string,
  operationId: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const current = operationIdsByDraft.get(draftId) ?? EMPTY_SET;
  if (current.has(operationId)) return operationIdsByDraft;
  const next = new Map(operationIdsByDraft);
  next.set(draftId, new Set([...current, operationId]));
  return next;
}

function removeOperationId(
  operationIdsByDraft: ReadonlyMap<string, ReadonlySet<string>>,
  draftId: string,
  operationId: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const current = operationIdsByDraft.get(draftId);
  if (!current?.has(operationId)) return operationIdsByDraft;
  const nextDraftSet = new Set(current);
  nextDraftSet.delete(operationId);
  const next = new Map(operationIdsByDraft);
  if (nextDraftSet.size === 0) next.delete(draftId);
  else next.set(draftId, nextDraftSet);
  return next;
}

const EMPTY_SET = new Set<string>();
