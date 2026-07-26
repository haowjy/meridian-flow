/** One command/state policy for draft review selection and disposition. */
import type { DraftAcceptResponse } from "@meridian/contracts/drafts";

export type DraftDispositionTarget =
  | { kind: "apply-draft"; documentId: string; draftId: string }
  | { kind: "discard-draft"; documentId: string; draftId: string }
  | {
      kind: "apply-operation" | "discard-operation";
      documentId: string;
      draftId: string;
      operationId: string;
    }
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
  | { kind: "discarded" }
  | { kind: "failed"; code: InlineReviewMessageCode };

export type DraftApplyScope = "draft" | "operation";
export type DraftBatchErrorCode = "apply-failed" | "discard-offline";

export type DraftApplyPreview = {
  documentId: string;
  draftId: string;
  operationIds: readonly string[];
  draftRevisionToken: number;
  branchId?: string;
};

export type DraftApplyRequest = {
  draftId: string;
  branchId?: string;
};

export type DraftApplyOutcome = {
  command: Extract<DraftCommandOutcome, { kind: "applied" }>;
  message: InlineReviewMessage | null;
  refreshDraftId: string | null;
  materializedDocument: boolean;
};

export type DraftReviewCommandPorts = {
  loadPreview: (selection: DraftReviewSelection) => Promise<DraftApplyPreview>;
  apply: (
    selection: DraftReviewSelection,
    scope: DraftApplyScope,
    request: DraftApplyRequest,
  ) => Promise<DraftAcceptResponse>;
  discard: (
    selection: DraftReviewSelection,
    input: { branchId?: string; operationIds?: string[] },
  ) => Promise<void>;
  operationApplyStarted: (operationId: string) => void;
  operationDiscardStarted: () => void;
  batchStarted: () => void;
  batchSettled: (error: DraftBatchErrorCode | null) => void;
  applySettled: (selection: DraftReviewSelection, outcome: DraftApplyOutcome) => void;
  draftFailed: (
    selection: DraftReviewSelection,
    code: Extract<InlineReviewMessageCode, "apply-failed" | "discard-offline">,
  ) => void;
  draftDiscarded: (selection: DraftReviewSelection) => void;
};

/**
 * The complete disposition command facade. React supplies I/O ports; this
 * session owns reservation timing, preview choice, mutation sequencing, typed
 * outcomes, batches, and terminal callbacks.
 */
export class DraftReviewSession {
  readonly disposition = new DraftDispositionLock();

  constructor(private readonly ports: () => DraftReviewCommandPorts) {}

  applyReviewedDraft(
    selection: DraftReviewSelection,
    preview: DraftApplyPreview,
  ): Promise<DraftCommandOutcome> {
    return this.withReservation({ kind: "apply-draft", ...selection }, (reservation, ports) =>
      this.applyDraft(selection, reservation, ports, () =>
        acquireDraftApplyRequest({ scope: "draft", preview }),
      ),
    );
  }

  applyOperation(
    selection: DraftReviewSelection,
    operationId: string,
  ): Promise<DraftCommandOutcome> {
    return this.withReservation(
      { kind: "apply-operation", ...selection, operationId },
      (reservation, ports) => {
        ports.operationApplyStarted(operationId);
        return this.applyRequest(selection, "operation", reservation, ports, {
          draftId: selection.draftId,
        });
      },
    );
  }

  discardOperation(
    selection: DraftReviewSelection,
    operationId: string,
  ): Promise<DraftCommandOutcome> {
    return this.withReservation(
      { kind: "discard-operation", ...selection, operationId },
      async (reservation, ports) => {
        ports.operationDiscardStarted();
        try {
          const preview = await ports.loadPreview(selection);
          this.disposition.advance(reservation, "mutating");
          await ports.discard(selection, {
            ...(preview.branchId ? { branchId: preview.branchId } : {}),
            operationIds: [operationId],
          });
          this.disposition.advance(reservation, "settling");
          return { kind: "discarded" };
        } catch {
          return { kind: "failed", code: "discard-offline" };
        }
      },
    );
  }

  discardDraft(selection: DraftReviewSelection): Promise<DraftCommandOutcome> {
    return this.withReservation({ kind: "discard-draft", ...selection }, (reservation, ports) =>
      this.discardDraftWithReservation(selection, reservation, ports),
    );
  }

  async disposeDrafts(
    mode: "apply" | "discard",
    drafts: readonly DraftReviewSelection[],
  ): Promise<DraftCommandOutcome[]> {
    if (drafts.length === 0) return [];
    const reservation = this.disposition.reserve({ kind: "batch", mode, count: drafts.length });
    if (!reservation) return [{ kind: "blocked" }];
    const ports = this.ports();
    const outcomes: DraftCommandOutcome[] = [];
    ports.batchStarted();
    try {
      for (const draft of drafts) {
        const outcome = await (mode === "apply"
          ? this.applyDraft(draft, reservation, ports, () => this.currentDraftRequest(draft))
          : this.discardDraftWithReservation(draft, reservation, ports));
        outcomes.push(outcome);
        if (!batchOutcomeSucceeded(mode, outcome)) break;
      }
    } finally {
      this.disposition.release(reservation);
      ports.batchSettled(batchErrorCode(mode, outcomes));
    }
    return outcomes;
  }

  private applyDraft(
    selection: DraftReviewSelection,
    reservation: DraftDispositionReservation,
    ports: DraftReviewCommandPorts,
    acquireRequest: () => DraftApplyRequest | Promise<DraftApplyRequest>,
  ): Promise<DraftCommandOutcome> {
    this.disposition.retarget(reservation, { kind: "apply-draft", ...selection });
    return this.applyRequest(selection, "draft", reservation, ports, acquireRequest());
  }

  private async applyRequest(
    selection: DraftReviewSelection,
    scope: DraftApplyScope,
    reservation: DraftDispositionReservation,
    ports: DraftReviewCommandPorts,
    requestPromise: DraftApplyRequest | Promise<DraftApplyRequest>,
  ): Promise<DraftCommandOutcome> {
    try {
      const request = await requestPromise;
      this.disposition.advance(reservation, "mutating");
      const response = await ports.apply(selection, scope, request);
      this.disposition.advance(reservation, "settling");
      const outcome = draftApplyOutcome(scope, response);
      ports.applySettled(selection, outcome);
      return outcome.command;
    } catch {
      if (scope === "draft") ports.draftFailed(selection, "apply-failed");
      return { kind: "failed", code: "apply-failed" };
    }
  }

  private async discardDraftWithReservation(
    selection: DraftReviewSelection,
    reservation: DraftDispositionReservation,
    ports: DraftReviewCommandPorts,
  ): Promise<DraftCommandOutcome> {
    this.disposition.retarget(reservation, { kind: "discard-draft", ...selection });
    try {
      const preview = await ports.loadPreview(selection);
      this.disposition.advance(reservation, "mutating");
      await ports.discard(selection, {
        ...(preview.branchId ? { branchId: preview.branchId } : {}),
      });
      this.disposition.advance(reservation, "settling");
      ports.draftDiscarded(selection);
      return { kind: "discarded" };
    } catch {
      ports.draftFailed(selection, "discard-offline");
      return { kind: "failed", code: "discard-offline" };
    }
  }

  private currentDraftRequest(selection: DraftReviewSelection): DraftApplyRequest {
    return { draftId: selection.draftId };
  }

  private async withReservation(
    target: DraftDispositionTarget,
    command: (
      reservation: DraftDispositionReservation,
      ports: DraftReviewCommandPorts,
    ) => Promise<DraftCommandOutcome>,
  ): Promise<DraftCommandOutcome> {
    const reservation = this.disposition.reserve(target);
    if (!reservation) return { kind: "blocked" };
    const ports = this.ports();
    try {
      return await command(reservation, ports);
    } finally {
      this.disposition.release(reservation);
    }
  }
}

function batchOutcomeSucceeded(mode: "apply" | "discard", outcome: DraftCommandOutcome): boolean {
  return mode === "apply" ? outcome.kind === "applied" : outcome.kind === "discarded";
}

function batchErrorCode(
  mode: "apply" | "discard",
  outcomes: readonly DraftCommandOutcome[],
): DraftBatchErrorCode | null {
  return outcomes.at(-1)?.kind === "failed"
    ? mode === "apply"
      ? "apply-failed"
      : "discard-offline"
    : null;
}

export function acquireDraftApplyRequest(input: {
  scope: "draft";
  preview: DraftApplyPreview;
}): DraftApplyRequest {
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
  | "apply-dependencies-first"
  | "changes-moved-confirm-again"
  | "discard-stale"
  | "discard-finalized"
  | "discard-offline"
  | "discard-failed";

export type InlineReviewMessage = {
  code: InlineReviewMessageCode;
  tone?: "info" | "error";
};

/** Interpret a server Apply response exactly once for every Apply surface. */
export function draftApplyOutcome(
  _scope: DraftApplyScope,
  _response: DraftAcceptResponse,
): DraftApplyOutcome {
  return {
    command: { kind: "applied" },
    message: null,
    refreshDraftId: null,
    materializedDocument: true,
  };
}

function requestFromPreview(preview: Omit<DraftApplyPreview, "documentId">): DraftApplyRequest {
  return {
    draftId: preview.draftId,
    ...(preview.branchId ? { branchId: preview.branchId } : {}),
  };
}

export type DraftReviewSurface =
  | { kind: "none" }
  | ({ kind: "inline"; previewIdentity?: string } & DraftReviewSelection);

export type DraftReviewState = {
  surface: DraftReviewSurface;
  inlineReviewMessage: InlineReviewMessage | null;
  inlineDiscardError: InlineReviewMessageCode | null;
  dockDispositionError: DraftBatchErrorCode | null;
};

export type DraftReviewAction =
  | { type: "enterInline"; documentId: string; draftId: string }
  | { type: "inlineModelAvailable"; documentId: string; draftId: string; identity: string }
  | { type: "applySucceeded"; documentId: string; draftId: string; outcome: DraftApplyOutcome }
  | { type: "operationAcceptStarted"; operationId: string }
  | { type: "operationAcceptSucceeded"; message: InlineReviewMessage }
  | { type: "operationAcceptFailed"; message: InlineReviewMessage }
  | { type: "discardStarted" }
  | { type: "discardFailed"; code: InlineReviewMessageCode }
  | { type: "batchStarted" }
  | { type: "batchSettled"; error: DraftBatchErrorCode | null }
  | {
      type: "draftCommandFailed";
      selection: DraftReviewSelection;
      code: Extract<InlineReviewMessageCode, "apply-failed" | "discard-offline">;
    }
  | { type: "rejectSucceeded"; draftId: string }
  | { type: "exitInline" }
  | { type: "exitReview" };

export const EMPTY_DRAFT_REVIEW_STATE: DraftReviewState = {
  surface: { kind: "none" },
  inlineReviewMessage: null,
  inlineDiscardError: null,
  dockDispositionError: null,
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
        inlineReviewMessage: null,
        inlineDiscardError: null,
      };
    case "inlineModelAvailable":
      return stateAfterInlineModelAvailable(state, action);
    case "applySucceeded":
      return stateAfterAcceptResult(state, action);
    case "operationAcceptStarted":
      return {
        ...state,
        inlineReviewMessage: null,
      };
    case "operationAcceptSucceeded":
      return { ...state, inlineReviewMessage: action.message };
    case "operationAcceptFailed":
      return { ...state, inlineReviewMessage: action.message };
    case "discardStarted":
      return {
        ...state,
        inlineDiscardError: null,
      };
    case "discardFailed":
      return { ...state, inlineDiscardError: action.code };
    case "batchStarted":
      return { ...state, dockDispositionError: null };
    case "batchSettled":
      return { ...state, dockDispositionError: action.error };
    case "draftCommandFailed":
      return surfaceMatchesDraft(state.surface, action.selection)
        ? { ...state, inlineReviewMessage: { code: action.code, tone: "error" } }
        : state;
    case "rejectSucceeded":
      return clearDraftReviewState(state, action.draftId);
    case "exitInline":
      if (state.surface.kind !== "inline") return state;
      return clearInlineState({
        ...state,
        surface: { kind: "none" },
      });
    case "exitReview":
      return clearInlineState({
        ...state,
        surface: { kind: "none" },
      });
    default:
      return state;
  }
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
  const { draftId } = input;
  return clearDraftReviewState(state, draftId);
}

function clearDraftReviewState(state: DraftReviewState, draftId: string): DraftReviewState {
  const currentDraftId = state.surface.kind === "none" ? null : state.surface.draftId;
  return {
    ...state,
    surface: currentDraftId === draftId ? { kind: "none" } : state.surface,
    inlineReviewMessage: currentDraftId === draftId ? null : state.inlineReviewMessage,
    inlineDiscardError: currentDraftId === draftId ? null : state.inlineDiscardError,
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
  return { ...state, surface: nextSurface };
}

function clearInlineState(state: DraftReviewState): DraftReviewState {
  return {
    ...state,
    inlineReviewMessage: null,
    inlineDiscardError: null,
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
