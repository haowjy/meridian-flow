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
  | { kind: "undone" }
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
  undo: (selection: DraftReviewSelection, writeId: string) => Promise<void>;
  operationApplyStarted: (operationId: string) => void;
  operationDiscardStarted: () => void;
  applyStarted: () => void;
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
        return this.applyRequest(
          selection,
          "operation",
          reservation,
          ports,
          acquireDraftApplyRequest({
            scope: "operation",
            draftId: selection.draftId,
            operationId,
            loadLatestPreview: async () => {
              const preview = await ports.loadPreview(selection);
              return {
                operationIds: preview.operationIds,
                draftRevisionToken: preview.draftRevisionToken,
                ...(preview.branchId ? { branchId: preview.branchId } : {}),
              };
            },
          }),
        );
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

  undoOperation(selection: DraftReviewSelection, writeId: string): Promise<DraftCommandOutcome> {
    return this.withReservation(
      { kind: "undo-operation", ...selection, writeId },
      async (reservation, ports) => {
        try {
          this.disposition.advance(reservation, "mutating");
          await ports.undo(selection, writeId);
          this.disposition.advance(reservation, "settling");
          return { kind: "undone" };
        } catch {
          return { kind: "failed", code: "undo-failed" };
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
          ? this.applyDraft(draft, reservation, ports, () => this.currentDraftRequest(draft, ports))
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
    ports.applyStarted();
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
      if (request.operationIds.length === 0) {
        if (scope === "draft") ports.draftFailed(selection, "apply-failed");
        return { kind: "failed", code: "apply-failed" };
      }
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

  private async currentDraftRequest(
    selection: DraftReviewSelection,
    ports: DraftReviewCommandPorts,
  ): Promise<DraftApplyRequest> {
    const preview = await ports.loadPreview(selection);
    return acquireDraftApplyRequest({ scope: "draft", preview });
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
  return mode === "apply"
    ? outcome.kind === "applied" || outcome.kind === "partial-applied"
    : outcome.kind === "discarded";
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
  inlineReviewMessage: InlineReviewMessage | null;
  inlineDiscardError: InlineReviewMessageCode | null;
  dockDispositionError: DraftBatchErrorCode | null;
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
  staleDraft: null,
  inlineReviewMessage: null,
  inlineDiscardError: null,
  dockDispositionError: null,
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

function surfaceMatchesDraft(
  surface: DraftReviewSurface,
  selection: DraftReviewSelection,
): boolean {
  return surface.kind !== "none" && selectionMatches(surface, selection);
}

function selectionMatches(left: DraftReviewSelection | null, right: DraftReviewSelection): boolean {
  return left?.documentId === right.documentId && left.draftId === right.draftId;
}
