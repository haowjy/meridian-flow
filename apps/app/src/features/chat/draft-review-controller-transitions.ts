/** draft-review-controller-transitions — pure state machine for draft review sessions. */
import type { DraftAcceptResponse } from "@meridian/contracts/drafts";
import { type DraftApplyRefusal, draftApplyRefusalFromResponse } from "./draft-apply-refusal";

export type DraftReviewSelection = {
  documentId: string;
  draftId: string;
};

export type InlineDraftReview = DraftReviewSelection;

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
  | "changes-moved-confirm-again"
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

export type DraftReviewState = {
  surface: DraftReviewSurface;
  staleDraft: DraftReviewSelection | null;
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
  inlineReviewMessage: InlineReviewMessage | null;
  inlineDiscardError: InlineReviewMessageCode | null;
  applyRefusal: DraftApplyRefusal | null;
  /** Conflicts survive navigation; only re-review or disposition removes their entry. */
  concurrentConflicts: ReadonlyMap<string, DraftReviewSelection & { conflictedBlocks: string[] }>;
};

export type DraftReviewAction =
  | { type: "enterInline"; documentId: string; draftId: string }
  | { type: "inlineModelAvailable"; documentId: string; draftId: string; identity: string }
  | { type: "applyStarted" }
  | { type: "applySucceeded"; documentId: string; draftId: string; response: DraftAcceptResponse }
  | { type: "operationAcceptStarted"; operationId: string }
  | { type: "operationAcceptSucceeded"; message: InlineReviewMessage }
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
  staleDraft: null,
  pendingDiscardIdsByDraft: new Map(),
  activeDiscardDraftId: null,
  acceptingOperationId: null,
  inlineReviewMessage: null,
  inlineDiscardError: null,
  applyRefusal: null,
  concurrentConflicts: new Map(),
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
        staleDraft: null,
        inlineReviewMessage: null,
        inlineDiscardError: null,
      };
    case "inlineModelAvailable":
      return stateAfterInlineModelAvailable(state, action);
    case "applyStarted":
      return { ...state, applyRefusal: null };
    case "applySucceeded":
      return {
        ...stateAfterAcceptResult(state, action),
        acceptingOperationId: null,
        applyRefusal: draftApplyRefusalFromResponse(action.response),
      };
    case "operationAcceptStarted":
      // A start can't preempt an accept already in flight — the in-flight one
      // owns `acceptingOperationId` until it terminates. (The controller also
      // guards on the mutation's pending state; this keeps the reducer honest
      // if a second start ever reaches it.)
      if (state.acceptingOperationId) return state;
      return {
        ...state,
        acceptingOperationId: action.operationId,
        inlineReviewMessage: null,
        applyRefusal: null,
      };
    case "operationAcceptSucceeded":
      return { ...state, acceptingOperationId: null, inlineReviewMessage: action.message };
    case "operationAcceptFailed":
      return { ...state, acceptingOperationId: null, inlineReviewMessage: action.message };
    case "operationUndoAcceptSucceeded":
    case "operationUndoAcceptFailed":
      return { ...state, inlineReviewMessage: action.message };
    case "discardStarted":
      return {
        ...state,
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
        staleDraft: null,
      });
    case "exitReview":
      return clearInlineState({
        ...state,
        surface: { kind: "none" },
        staleDraft: null,
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
}): boolean {
  return (
    input.isPending ||
    input.isInlineDiscardPending ||
    input.isOperationAccepting === true ||
    input.isOperationUndoing === true
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
  if (response.status === "stale_draft") {
    return {
      ...state,
      surface: { kind: "inline", documentId, draftId: response.draftId },
      staleDraft: { documentId, draftId: response.draftId },
    };
  }
  if (response.status === "partial_applied") {
    return { ...state, staleDraft: null };
  }
  if (response.status === "concurrent_conflict") {
    const concurrentConflicts = new Map(state.concurrentConflicts);
    concurrentConflicts.set(reviewSelectionKey({ documentId, draftId }), {
      documentId,
      draftId,
      conflictedBlocks: response.conflictedBlocks,
    });
    return {
      ...state,
      staleDraft: null,
      concurrentConflicts,
    };
  }
  return clearDraftReviewState(state, draftId);
}

function clearDraftReviewState(state: DraftReviewState, draftId: string): DraftReviewState {
  const currentDraftId = state.surface.kind === "none" ? null : state.surface.draftId;
  const concurrentConflicts = new Map(state.concurrentConflicts);
  for (const [key, conflict] of concurrentConflicts) {
    if (conflict.draftId === draftId) concurrentConflicts.delete(key);
  }
  return {
    ...state,
    surface: currentDraftId === draftId ? { kind: "none" } : state.surface,
    staleDraft: state.staleDraft?.draftId === draftId ? null : state.staleDraft,
    concurrentConflicts,
  };
}

function stateAfterInlineModelAvailable(
  state: DraftReviewState,
  action: { documentId: string; draftId: string; identity: string },
): DraftReviewState {
  const nextSurface = surfaceMatchesDraft(state.surface, action)
    ? { ...state.surface, previewIdentity: action.identity }
    : state.surface;
  const priorIdentity =
    surfaceMatchesDraft(state.surface, action) && state.surface.kind === "inline"
      ? state.surface.previewIdentity
      : undefined;
  if (!priorIdentity || priorIdentity === action.identity) {
    return { ...state, surface: nextSurface };
  }
  // A new server preview identity is the explicit re-review transition: the
  // writer is now looking at a model rebuilt after the rejected disposition.
  const concurrentConflicts = new Map(state.concurrentConflicts);
  concurrentConflicts.delete(reviewSelectionKey(action));
  return { ...state, surface: nextSurface, concurrentConflicts };
}

export function conflictForSelection(
  state: DraftReviewState,
  selection: DraftReviewSelection | null,
): (DraftReviewSelection & { conflictedBlocks: string[] }) | null {
  return selection ? (state.concurrentConflicts.get(reviewSelectionKey(selection)) ?? null) : null;
}

function reviewSelectionKey(selection: DraftReviewSelection): string {
  return `${selection.documentId}\0${selection.draftId}`;
}

function clearInlineState(state: DraftReviewState): DraftReviewState {
  return {
    ...state,
    acceptingOperationId: null,
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

const EMPTY_SET = new Set<string>();
