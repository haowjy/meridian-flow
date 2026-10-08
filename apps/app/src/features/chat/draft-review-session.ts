/** One command/state policy for Work-draft selection and disposition. */

import type { DraftApplyChangesResponse, DraftDiscardResponse } from "@meridian/contracts/drafts";
import {
  beginChangeCommand,
  type ChangeFailureCode,
  type ChangeRef,
  failChangeCommand,
  releaseChangeCommand,
} from "@/client/query/change-command-record";
import {
  beginDraftCommand,
  type DraftCommandFailureCode,
  failDraftCommand,
  releaseDraftCommand,
} from "@/client/query/draft-command-record";

export type DraftDispositionTarget =
  | { kind: "apply-draft"; documentId: string; draftId: string }
  | { kind: "discard-draft"; documentId: string; draftId: string }
  | {
      kind: "apply-change" | "discard-change";
      documentId: string;
      draftId: string;
      classId: string;
    }
  | { kind: "batch"; mode: "apply" | "discard"; count: number };

export type DraftDispositionState =
  | { busy: false }
  | { busy: true; target: DraftDispositionTarget };

export type DraftDispositionReservation = symbol;

/**
 * The session's synchronous disposition authority. Reservation happens before
 * any mutation promise is created, so every command observes the same lock
 * even before React can render its pending state.
 */
export class DraftDispositionLock {
  private state: DraftDispositionState = { busy: false };
  private owner: DraftDispositionReservation | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): DraftDispositionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reserve(target: DraftDispositionTarget): DraftDispositionReservation | null {
    if (this.state.busy) return null;
    const reservation = Symbol(target.kind);
    this.owner = reservation;
    this.publish({ busy: true, target });
    return reservation;
  }

  retarget(reservation: DraftDispositionReservation, target: DraftDispositionTarget): boolean {
    if (this.owner !== reservation) return false;
    this.publish({ busy: true, target });
    return true;
  }

  release(reservation: DraftDispositionReservation): boolean {
    if (this.owner !== reservation) return false;
    this.owner = null;
    this.publish({ busy: false });
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
  | { kind: "apply-outcome-unknown" }
  | { kind: "discarded" }
  /** One change was applied or discarded; the rest of the draft is untouched. */
  | { kind: "change-settled"; mode: "apply" | "discard" }
  /** One change's command did not land; the reason is held on the change. */
  | { kind: "change-refused"; mode: "apply" | "discard"; code: ChangeFailureCode }
  | { kind: "failed"; code: DraftCommandFailureCode };

export type DraftBatchErrorCode = "apply-failed" | "apply-unknown" | "discard-offline";

export type ChangeApplyRequest = {
  operationIds: string[];
  liveRevisionToken: string;
  draftRevisionToken: string;
};

type ChangeTokens = Pick<ChangeApplyRequest, "liveRevisionToken" | "draftRevisionToken">;

export type DraftReviewCommandPorts = {
  /** The Work these commands act in; part of every command record's identity. */
  scope: { projectId: string; workId: string };
  /** Resolves once the server has confirmed Apply, or "unknown" when the response was lost. */
  apply: (selection: DraftReviewSelection) => Promise<"applied" | "unknown">;
  /** Whole-draft Discard: unfenced, no operation ids. */
  discard: (selection: DraftReviewSelection) => Promise<void>;
  /**
   * Discard the complete classes `request` names, fenced by the revision tokens
   * the writer saw. Resolves with the server's answer (`stale` is data, not an
   * error), or "unknown" when the request got none (it may have landed), and
   * rejects when the server refused it.
   */
  discardChanges: (
    selection: DraftReviewSelection,
    request: ChangeApplyRequest,
  ) => Promise<DraftDiscardResponse | "unknown">;
  /**
   * Apply the complete classes `request` names. Resolves with the server's
   * answer, or "unknown" when the request got none (it may have landed), and
   * rejects when the server refused it.
   */
  applyChanges: (
    selection: DraftReviewSelection,
    request: ChangeApplyRequest,
  ) => Promise<DraftApplyChangesResponse | "unknown">;
  /** The server confirmed one change: drop it from the cached preview and refresh around it. */
  changeConfirmed: (
    selection: DraftReviewSelection,
    change: ChangeRef,
    mode: "apply" | "discard",
  ) => void;
  batchStarted: (mode: "apply" | "discard") => void;
  batchSettled: (error: DraftBatchErrorCode | null) => void;
  draftDiscardStarted: (selection: DraftReviewSelection) => void;
  draftApplied: (selection: DraftReviewSelection) => void;
  draftDiscarded: (selection: DraftReviewSelection) => void;
};

/**
 * The complete disposition command facade. React supplies I/O ports; this
 * session owns reservation timing, mutation sequencing, batches, and terminal
 * callbacks.
 */
export class DraftReviewSession {
  readonly disposition = new DraftDispositionLock();

  constructor(private readonly ports: () => DraftReviewCommandPorts) {}

  applyReviewedDraft(selection: DraftReviewSelection): Promise<DraftCommandOutcome> {
    return this.withReservation({ kind: "apply-draft", ...selection }, (reservation, ports) =>
      this.applyDraft(selection, reservation, ports),
    );
  }

  /**
   * Apply one change (a complete server closure class) to live. The change
   * leaves every surface at once; a refusal or a lost request brings it back
   * with the reason held on it (`change-command-record`).
   */
  applyChange(
    selection: DraftReviewSelection,
    change: ChangeRef,
    tokens: ChangeTokens,
  ): Promise<DraftCommandOutcome> {
    return this.changeCommand("apply", selection, change, tokens, (ports, request) =>
      ports.applyChanges(selection, request),
    );
  }

  /**
   * Discard one change: its operations go in a selective Discard, the draft's
   * text returns to live's. Fenced by the same tokens as Apply, and answered the
   * same way: `stale` brings the change back; it never reads as a discarded or
   * closed draft.
   */
  discardChange(
    selection: DraftReviewSelection,
    change: ChangeRef,
    tokens: ChangeTokens,
  ): Promise<DraftCommandOutcome> {
    return this.changeCommand("discard", selection, change, tokens, (ports, request) =>
      ports.discardChanges(selection, request),
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
    ports.batchStarted(mode);
    try {
      for (const draft of drafts) {
        const outcome = await (mode === "apply"
          ? this.applyDraft(draft, reservation, ports)
          : this.discardDraftWithReservation(draft, reservation, ports));
        // A refusal belongs to the draft it was sent for and is held there
        // (`failDraftCommand`); the drafts after it are independent documents
        // and still get their turn, so the batch never ends half-done unannounced.
        // Nothing here moves the writer: where they are is theirs to choose.
        outcomes.push(outcome);
      }
    } finally {
      this.disposition.release(reservation);
      ports.batchSettled(batchErrorCode(mode, outcomes));
    }
    return outcomes;
  }

  /**
   * One change's Apply or Discard. Both are answered by the same statuses
   * (`applied` or `discarded` confirms, `gone` drops the change with a word,
   * anything else brings it back with its reason), and a request that got no
   * answer is held as `unknown` for both: it may have landed, so it is never
   * read as a refusal and never inferred from the list.
   */
  private changeCommand(
    mode: "apply" | "discard",
    selection: DraftReviewSelection,
    change: ChangeRef,
    tokens: ChangeTokens,
    send: (
      ports: DraftReviewCommandPorts,
      request: ChangeApplyRequest,
    ) => Promise<{ status: string } | "unknown">,
  ): Promise<DraftCommandOutcome> {
    return this.withReservation(
      { kind: `${mode}-change`, ...selection, classId: change.classId },
      async (_reservation, ports) => {
        const draft = { ...ports.scope, ...selection };
        if (!beginChangeCommand(draft, change, mode)) return { kind: "blocked" };
        try {
          let response: { status: string } | "unknown";
          try {
            response = await send(ports, { operationIds: [...change.operationIds], ...tokens });
          } catch {
            failChangeCommand(draft, change, mode, "offline");
            return { kind: "change-refused", mode, code: "offline" };
          }
          if (response === "unknown") {
            failChangeCommand(draft, change, mode, "unknown");
            return { kind: "change-refused", mode, code: "unknown" };
          }
          if (response.status === (mode === "apply" ? "applied" : "discarded")) {
            ports.changeConfirmed(selection, change, mode);
            return { kind: "change-settled", mode };
          }
          if (response.status === "gone") {
            // Nothing left to handle: the change leaves, with a word about it.
            ports.changeConfirmed(selection, change, mode);
            return { kind: "change-refused", mode, code: "gone" };
          }
          const code = response.status === "draft_only" ? "draft-only" : "stale";
          failChangeCommand(draft, change, mode, code);
          return { kind: "change-refused", mode, code };
        } finally {
          releaseChangeCommand(draft);
        }
      },
    );
  }

  private async applyDraft(
    selection: DraftReviewSelection,
    reservation: DraftDispositionReservation,
    ports: DraftReviewCommandPorts,
  ): Promise<DraftCommandOutcome> {
    const draft = { ...ports.scope, ...selection };
    if (!beginDraftCommand(draft)) return { kind: "blocked" };
    // Whatever throws after the claim, the finally gives it back unless the
    // command already turned it into a confirmation or a held failure.
    try {
      this.disposition.retarget(reservation, { kind: "apply-draft", ...selection });
      let result: "applied" | "unknown";
      try {
        result = await ports.apply(selection);
      } catch {
        // Held on the draft, not on the review: the writer may have moved on
        // to the next draft, and this one's row still has to say it was refused.
        failDraftCommand(draft, "apply-failed");
        return { kind: "failed", code: "apply-failed" };
      }
      if (result === "unknown") {
        failDraftCommand(draft, "apply-unknown");
        return { kind: "apply-outcome-unknown" };
      }
      ports.draftApplied(selection);
      return { kind: "applied" };
    } finally {
      releaseDraftCommand(draft);
    }
  }

  private async discardDraftWithReservation(
    selection: DraftReviewSelection,
    reservation: DraftDispositionReservation,
    ports: DraftReviewCommandPorts,
  ): Promise<DraftCommandOutcome> {
    const draft = { ...ports.scope, ...selection };
    if (!beginDraftCommand(draft)) return { kind: "blocked" };
    try {
      this.disposition.retarget(reservation, { kind: "discard-draft", ...selection });
      // The optimistic callback runs under the claim: if it throws, nothing was
      // dispatched and the claim must not outlive the call.
      ports.draftDiscardStarted(selection);
      try {
        await ports.discard(selection);
      } catch {
        failDraftCommand(draft, "discard-offline");
        return { kind: "failed", code: "discard-offline" };
      }
      releaseDraftCommand(draft);
      ports.draftDiscarded(selection);
      return { kind: "discarded" };
    } finally {
      releaseDraftCommand(draft);
    }
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

function batchErrorCode(
  mode: "apply" | "discard",
  outcomes: readonly DraftCommandOutcome[],
): DraftBatchErrorCode | null {
  if (outcomes.some((outcome) => outcome.kind === "failed")) {
    return mode === "apply" ? "apply-failed" : "discard-offline";
  }
  return outcomes.some((outcome) => outcome.kind === "apply-outcome-unknown")
    ? "apply-unknown"
    : null;
}

export type DraftReviewSelection = {
  documentId: string;
  draftId: string;
};

export type InlineDraftReview = {
  kind: "inline";
  previewIdentity?: string;
  /** The change (server closure class) the writer is looking at, if any. */
  focusedClassId?: string | null;
  /**
   * The writer handled the last change. The one completion state every
   * surface reads (header, list, editor); it comes from the command's own
   * answer, never from how many changes are left on screen. It also carries
   * the document's name, since the draft leaves the Work's list.
   */
  completion?: ReviewCompletion;
  /**
   * The review body has painted and the review chrome (header, chip swap)
   * may show with it. Until then the plain live view is held, header
   * included, so the writer never sees review chrome over live text.
   */
  shown?: boolean;
} & DraftReviewSelection;

/**
 * `pending`: the last change's command is in flight; its outcome is unknown.
 * The writer sees what they did (the change is gone), but nothing is finished
 * and nothing is editable that could land in the wrong place. `closed`: the
 * server answered that it closed the draft; the review stays open on "No
 * changes left" until the writer moves on. A success that did not close the
 * draft is neither: the review simply carries on.
 */
export type ReviewCompletion =
  | { phase: "pending"; mode: "apply" | "discard"; documentName: string | null }
  | { phase: "closed"; documentName: string | null };

export type DraftReviewSurface = { kind: "none" } | InlineDraftReview;

/** What a toast says; the render layer owns the words. */
export type ReviewToastCode = "applied" | "discarded" | "change-gone";

export type ReviewToast = { id: number; code: ReviewToastCode; tone: "info" | "error" };

export type DraftReviewState = {
  surface: DraftReviewSurface;
  dockDispositionError: DraftBatchErrorCode | null;
  /** The header's "Show changes": false hides every mark in the manuscript. */
  marksVisible: boolean;
  toast: ReviewToast | null;
  toastSeq: number;
};

export type DraftReviewAction =
  | { type: "enterInline"; documentId: string; draftId: string }
  | { type: "inlineModelAvailable"; documentId: string; draftId: string; identity: string }
  | { type: "inlineShown"; documentId: string; draftId: string; shown: boolean }
  | { type: "applySucceeded"; documentId: string; draftId: string }
  | { type: "changeFocused"; documentId: string; draftId: string; classId: string | null }
  | {
      type: "reviewCompleting";
      documentId: string;
      draftId: string;
      mode: "apply" | "discard";
      documentName: string | null;
    }
  | {
      type: "reviewClosed";
      documentId: string;
      draftId: string;
      documentName: string | null;
    }
  | { type: "reviewReopened"; documentId: string; draftId: string }
  | { type: "marksVisible"; visible: boolean }
  | { type: "toast"; code: ReviewToastCode; tone: "info" | "error" }
  | { type: "toastDismissed"; id: number }
  | { type: "batchStarted" }
  | { type: "batchSettled"; error: DraftBatchErrorCode | null }
  | { type: "discardSucceeded"; draftId: string }
  | { type: "exitInline" }
  | { type: "exitReview" };

export const EMPTY_DRAFT_REVIEW_STATE: DraftReviewState = {
  surface: { kind: "none" },
  dockDispositionError: null,
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
      return {
        ...state,
        surface: inlineSurfaceForEnter(state.surface, action),
      };
    case "inlineModelAvailable":
      return stateAfterInlineModelAvailable(state, action);
    case "inlineShown":
      if (!surfaceMatchesDraft(state.surface, action) || state.surface.kind !== "inline") {
        return state;
      }
      if ((state.surface.shown ?? false) === action.shown) return state;
      return { ...state, surface: { ...state.surface, shown: action.shown } };
    case "applySucceeded":
      return clearDraftReviewState(state, action.draftId);
    case "changeFocused":
      if (!surfaceMatchesDraft(state.surface, action) || state.surface.kind !== "inline") {
        return state;
      }
      if ((state.surface.focusedClassId ?? null) === action.classId) return state;
      return { ...state, surface: { ...state.surface, focusedClassId: action.classId } };
    case "reviewCompleting":
      if (!surfaceMatchesDraft(state.surface, action) || state.surface.kind !== "inline") {
        return state;
      }
      // A closed draft stays closed; a prediction never overrides the server's answer.
      return state.surface.completion
        ? state
        : {
            ...state,
            surface: {
              ...state.surface,
              completion: {
                phase: "pending",
                mode: action.mode,
                documentName: action.documentName,
              },
            },
          };
    case "reviewClosed":
      if (!surfaceMatchesDraft(state.surface, action) || state.surface.kind !== "inline") {
        return state;
      }
      return state.surface.completion?.phase === "closed"
        ? state
        : {
            ...state,
            surface: {
              ...state.surface,
              completion: { phase: "closed", documentName: action.documentName },
            },
          };
    case "reviewReopened": {
      if (!surfaceMatchesDraft(state.surface, action) || state.surface.kind !== "inline") {
        return state;
      }
      // Only a prediction is withdrawn: what the server closed stays closed.
      if (state.surface.completion?.phase !== "pending") return state;
      const { completion: _completion, ...reopened } = state.surface;
      return { ...state, surface: reopened };
    }
    case "marksVisible":
      return state.marksVisible === action.visible
        ? state
        : { ...state, marksVisible: action.visible };
    case "toast":
      return {
        ...state,
        toastSeq: state.toastSeq + 1,
        toast: { id: state.toastSeq + 1, code: action.code, tone: action.tone },
      };
    case "toastDismissed":
      return state.toast?.id === action.id ? { ...state, toast: null } : state;
    case "batchStarted":
      return { ...state, dockDispositionError: null };
    case "batchSettled":
      return { ...state, dockDispositionError: action.error };
    case "discardSucceeded":
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

function clearDraftReviewState(state: DraftReviewState, draftId: string): DraftReviewState {
  const currentDraftId = state.surface.kind === "none" ? null : state.surface.draftId;
  return {
    ...state,
    surface: currentDraftId === draftId ? { kind: "none" } : state.surface,
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

/** Leaving review: the next review starts with its marks showing. */
function clearInlineState(state: DraftReviewState): DraftReviewState {
  return { ...state, marksVisible: true };
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
