/** One command/state policy for draft review selection and disposition. */
import type {
  DraftAcceptResponse,
  DraftApplyRefusal as DraftApplyRefusalResponse,
} from "@meridian/contracts/drafts";

export type DraftDispositionTarget =
  | { kind: "apply-draft"; documentId: string; draftId: string }
  | { kind: "discard-draft"; documentId: string; draftId: string }
  | {
      kind: "apply-operation" | "discard-operation";
      documentId: string;
      draftId: string;
      operationId: string;
    }
  | { kind: "undo-operation"; documentId: string; draftId: string; writeId: string }
  | { kind: "batch"; mode: "apply" | "discard"; count: number };

export type DraftDispositionState =
  | { phase: "idle" }
  | {
      phase: "acquiring" | "mutating" | "settling";
      target: DraftDispositionTarget;
    };

export type DraftDispositionReservation = symbol;

/**
 * The session's synchronous disposition authority. Reservation happens before
 * any preview read or mutation promise is created, so every command observes
 * the same lock even before React can render its pending state.
 */
export class DraftDispositionLock {
  private state: DraftDispositionState = { phase: "idle" };
  private owner: DraftDispositionReservation | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): DraftDispositionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reserve(target: DraftDispositionTarget): DraftDispositionReservation | null {
    if (this.state.phase !== "idle") return null;
    const reservation = Symbol(target.kind);
    this.owner = reservation;
    this.publish({ phase: "acquiring", target });
    return reservation;
  }

  advance(reservation: DraftDispositionReservation, phase: "mutating" | "settling"): boolean {
    if (this.owner !== reservation || this.state.phase === "idle") return false;
    this.publish({ phase, target: this.state.target });
    return true;
  }

  retarget(reservation: DraftDispositionReservation, target: DraftDispositionTarget): boolean {
    if (this.owner !== reservation) return false;
    this.publish({ phase: "acquiring", target });
    return true;
  }

  release(reservation: DraftDispositionReservation): boolean {
    if (this.owner !== reservation) return false;
    this.owner = null;
    this.publish({ phase: "idle" });
    return true;
  }

  private publish(state: DraftDispositionState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export type DraftCommandOutcome =
  | { kind: "blocked" }
  | { kind: "applied" }
  | { kind: "partial-applied"; writeId: string }
  | { kind: "stale"; draftId: string }
  | {
      kind: "conflict";
      conflictedBlocks: string[];
      refusal: DraftApplyRefusal;
    }
  | { kind: "discarded" }
  | { kind: "discard-settling"; draftId: string; operationId: string }
  | { kind: "undone" }
  | { kind: "failed"; code: InlineReviewMessageCode };

export type DraftApplyScope = "draft" | "operation";

export type DraftApplyPreview = {
  documentId: string;
  draftId: string;
  operationIds: readonly string[];
  draftRevisionToken: number;
  branchId?: string;
};

type LatestDraftPreviewRevision = {
  operationIds: readonly string[];
  draftRevisionToken: number;
  branchId?: string;
};

export type DraftApplyRequest = {
  draftId: string;
  operationIds: string[];
  draftRevisionToken: number;
  branchId?: string;
};

export type DraftApplyOutcome = {
  command: Extract<
    DraftCommandOutcome,
    { kind: "applied" | "partial-applied" | "stale" | "conflict" }
  >;
  message: InlineReviewMessage | null;
  refreshDraftId: string | null;
  materializedDocument: boolean;
};

export function acquireDraftApplyRequest(input: {
  scope: "draft";
  preview: DraftApplyPreview;
}): DraftApplyRequest;
export function acquireDraftApplyRequest(input: {
  scope: "operation";
  draftId: string;
  operationId: string;
  loadLatestPreview: () => Promise<LatestDraftPreviewRevision>;
}): Promise<DraftApplyRequest>;
export function acquireDraftApplyRequest(
  input:
    | { scope: "draft"; preview: DraftApplyPreview }
    | {
        scope: "operation";
        draftId: string;
        operationId: string;
        loadLatestPreview: () => Promise<LatestDraftPreviewRevision>;
      },
): DraftApplyRequest | Promise<DraftApplyRequest> {
  if (input.scope === "operation") {
    return input.loadLatestPreview().then((preview) =>
      requestFromPreview({
        ...preview,
        draftId: input.draftId,
        operationIds: [input.operationId],
      }),
    );
  }
  return requestFromPreview(input.preview);
}

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

export type DraftApplyRefusal = {
  reason: "stale_draft" | "unsynced_live_edits" | "protected_resurrection";
  passages: Array<{ body: string }>;
};

/** Interpret a server Apply response exactly once for every Apply surface. */
export function draftApplyOutcome(
  scope: DraftApplyScope,
  response: DraftAcceptResponse,
): DraftApplyOutcome {
  const refreshDraftId = response.status === "stale_draft" ? response.draftId : null;
  const materializedDocument =
    response.status === "applied" ||
    (scope === "operation" && response.status === "partial_applied");
  if (response.status === "applied") {
    return {
      command: { kind: "applied" },
      message: null,
      refreshDraftId,
      materializedDocument,
    };
  }
  if (response.status === "partial_applied") {
    return {
      command: { kind: "partial-applied", writeId: response.writeId },
      message: scope === "operation" ? { code: "change-applied", writeId: response.writeId } : null,
      refreshDraftId,
      materializedDocument,
    };
  }
  if (response.status === "stale_draft") {
    return {
      command: { kind: "stale", draftId: response.draftId },
      message: scope === "operation" ? { code: "changes-moved-refreshed" } : null,
      refreshDraftId,
      materializedDocument,
    };
  }
  return {
    command: {
      kind: "conflict",
      conflictedBlocks: response.conflictedBlocks,
      refusal: draftApplyRefusalFromResponse(response),
    },
    message: null,
    refreshDraftId,
    materializedDocument,
  };
}

function requestFromPreview(preview: Omit<DraftApplyPreview, "documentId">): DraftApplyRequest {
  return {
    draftId: preview.draftId,
    ...(preview.branchId ? { branchId: preview.branchId } : {}),
    draftRevisionToken: preview.draftRevisionToken,
    operationIds: [...preview.operationIds],
  };
}

function draftApplyRefusalFromResponse(response: DraftApplyRefusalResponse): DraftApplyRefusal {
  const protectedResurrection = response.conflicts.some(
    (conflict) => conflict.effect === "resurrection",
  );
  return {
    reason: protectedResurrection ? "protected_resurrection" : "unsynced_live_edits",
    passages: response.conflicts.flatMap((conflict) => {
      const captured =
        conflict.effect === "resurrection" ? conflict.captured.base : conflict.captured.live;
      return captured ? [{ body: bodyFromHashline(captured) }] : [];
    }),
  };
}

function bodyFromHashline(value: string): string {
  const separator = value.indexOf("|");
  return separator < 0 ? value : value.slice(separator + 1).replace(/^\n/, "");
}

export type DraftReviewSurface =
  | { kind: "none" }
  | ({ kind: "inline"; previewIdentity?: string } & DraftReviewSelection);

export type DraftReviewState = {
  surface: DraftReviewSurface;
  staleDraft: DraftReviewSelection | null;
  /** Operation ids awaiting their query-backed preview settle signal. */
  pendingDiscardIdsByDraft: ReadonlyMap<string, ReadonlySet<string>>;
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
  | { type: "applySucceeded"; documentId: string; draftId: string; outcome: DraftApplyOutcome }
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
        applyRefusal:
          action.outcome.command.kind === "conflict"
            ? action.outcome.command.refusal
            : action.outcome.command.kind === "stale"
              ? { reason: "stale_draft", passages: [] }
              : null,
      };
    case "operationAcceptStarted":
      return {
        ...state,
        inlineReviewMessage: null,
        applyRefusal: null,
      };
    case "operationAcceptSucceeded":
      return { ...state, inlineReviewMessage: action.message };
    case "operationAcceptFailed":
      return { ...state, inlineReviewMessage: action.message };
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

export function inlineReviewFromState(state: DraftReviewState): InlineDraftReview | null {
  return state.surface.kind === "inline" ? state.surface : null;
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
  input: { documentId: string; draftId: string; outcome: DraftApplyOutcome },
): DraftReviewState {
  const { documentId, draftId, outcome } = input;
  if (outcome.command.kind === "stale") {
    return {
      ...state,
      surface: { kind: "inline", documentId, draftId: outcome.command.draftId },
      staleDraft: { documentId, draftId: outcome.command.draftId },
    };
  }
  if (outcome.command.kind === "partial-applied") {
    return { ...state, staleDraft: null };
  }
  if (outcome.command.kind === "conflict") {
    const concurrentConflicts = new Map(state.concurrentConflicts);
    concurrentConflicts.set(reviewSelectionKey({ documentId, draftId }), {
      documentId,
      draftId,
      conflictedBlocks: outcome.command.conflictedBlocks,
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
  if (priorIdentity === action.identity) return state;
  if (!priorIdentity) {
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
    inlineDiscardError: error,
  };
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
