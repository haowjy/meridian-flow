/** One command/state policy for Work-draft selection and disposition. */

import type { DraftApplyChangesResponse } from "@meridian/contracts/drafts";
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
  | { kind: "failed"; code: InlineReviewMessageCode };

export type DraftBatchErrorCode = "apply-failed" | "apply-unknown" | "discard-offline";

export type ChangeApplyRequest = {
  operationIds: string[];
  liveRevisionToken: string;
  draftRevisionToken: string;
};

export type DraftReviewCommandPorts = {
  /** The Work these commands act in; part of every command record's identity. */
  scope: { projectId: string; workId: string };
  /** Resolves once the server has confirmed Apply, or "unknown" when the response was lost. */
  apply: (selection: DraftReviewSelection) => Promise<"applied" | "unknown">;
  discard: (selection: DraftReviewSelection, input?: { operationIds: string[] }) => Promise<void>;
  /** Apply the complete classes `request` names; resolves with the server's answer, rejects when it got none. */
  applyChanges: (
    selection: DraftReviewSelection,
    request: ChangeApplyRequest,
  ) => Promise<DraftApplyChangesResponse>;
  /** The server confirmed one change: drop it from the cached preview and refresh around it. */
  changeConfirmed: (
    selection: DraftReviewSelection,
    change: ChangeRef,
    mode: "apply" | "discard",
  ) => void;
  batchStarted: () => void;
  batchSettled: (error: DraftBatchErrorCode | null) => void;
  draftDiscardStarted: (selection: DraftReviewSelection) => void;
  draftApplied: (selection: DraftReviewSelection) => void;
  draftFailed: (
    selection: DraftReviewSelection,
    code: Extract<InlineReviewMessageCode, "apply-failed" | "apply-unknown" | "discard-offline">,
  ) => void;
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
    tokens: Pick<ChangeApplyRequest, "liveRevisionToken" | "draftRevisionToken">,
  ): Promise<DraftCommandOutcome> {
    return this.withReservation(
      { kind: "apply-change", ...selection, classId: change.classId },
      async (_reservation, ports) => {
        const draft = { ...ports.scope, ...selection };
        if (!beginChangeCommand(draft, change, "apply")) return { kind: "blocked" };
        try {
          let response: DraftApplyChangesResponse;
          try {
            response = await ports.applyChanges(selection, {
              operationIds: [...change.operationIds],
              ...tokens,
            });
          } catch {
            failChangeCommand(draft, change, "apply", "offline");
            return { kind: "change-refused", mode: "apply", code: "offline" };
          }
          if (response.status === "applied") {
            ports.changeConfirmed(selection, change, "apply");
            return { kind: "change-settled", mode: "apply" };
          }
          if (response.status === "gone") {
            // Nothing to apply any more: the change leaves, with a word about it.
            ports.changeConfirmed(selection, change, "apply");
            return { kind: "change-refused", mode: "apply", code: "gone" };
          }
          const code = response.status === "draft_only" ? "draft-only" : "stale";
          failChangeCommand(draft, change, "apply", code);
          return { kind: "change-refused", mode: "apply", code };
        } finally {
          releaseChangeCommand(draft, change);
        }
      },
    );
  }

  /** Discard one change: its operations go in a selective Discard, the draft's text returns to live's. */
  discardChange(selection: DraftReviewSelection, change: ChangeRef): Promise<DraftCommandOutcome> {
    return this.withReservation(
      { kind: "discard-change", ...selection, classId: change.classId },
      async (_reservation, ports) => {
        const draft = { ...ports.scope, ...selection };
        if (!beginChangeCommand(draft, change, "discard")) return { kind: "blocked" };
        try {
          try {
            await ports.discard(selection, { operationIds: [...change.operationIds] });
          } catch {
            failChangeCommand(draft, change, "discard", "offline");
            return { kind: "change-refused", mode: "discard", code: "offline" };
          }
          ports.changeConfirmed(selection, change, "discard");
          return { kind: "change-settled", mode: "discard" };
        } finally {
          releaseChangeCommand(draft, change);
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
          ? this.applyDraft(draft, reservation, ports)
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
        releaseDraftCommand(draft);
        ports.draftFailed(selection, "apply-failed");
        return { kind: "failed", code: "apply-failed" };
      }
      if (result === "unknown") {
        failDraftCommand(draft, "apply-unknown");
        ports.draftFailed(selection, "apply-unknown");
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
        ports.draftFailed(selection, "discard-offline");
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

function batchOutcomeSucceeded(mode: "apply" | "discard", outcome: DraftCommandOutcome): boolean {
  return mode === "apply" ? outcome.kind === "applied" : outcome.kind === "discarded";
}

function batchErrorCode(
  mode: "apply" | "discard",
  outcomes: readonly DraftCommandOutcome[],
): DraftBatchErrorCode | null {
  const last = outcomes.at(-1)?.kind;
  if (last === "apply-outcome-unknown") return "apply-unknown";
  return last === "failed" ? (mode === "apply" ? "apply-failed" : "discard-offline") : null;
}

export type DraftReviewSelection = {
  documentId: string;
  draftId: string;
};

/**
 * Stable identifiers for every writer-facing review message. The controller is
 * a state machine and must not carry localized copy; it emits a code and the
 * render layer (`DockChangesView`) turns it into Lingui text. Keep this the
 * single source of message identity for the review's whole-draft messages.
 */
export type InlineReviewMessageCode = "apply-failed" | DraftCommandFailureCode;

export type InlineReviewMessage = {
  code: InlineReviewMessageCode;
  tone?: "info" | "error";
};

export type InlineDraftReview = {
  kind: "inline";
  previewIdentity?: string;
  /** The change (server closure class) the writer is looking at, if any. */
  focusedClassId?: string | null;
  /**
   * The writer handled the last change. The draft now matches live and the
   * server has closed it (it leaves the Work's list); the review stays open,
   * saying so, until the writer moves on. Its own state, not list membership,
   * holds it, so it also carries the document's name for the chrome.
   */
  cleared?: { documentName: string | null };
  /**
   * The review body has painted and the review chrome (header, chip swap)
   * may show with it. Until then the plain live view is held, header
   * included, so the writer never sees review chrome over live text.
   */
  shown?: boolean;
} & DraftReviewSelection;

export type DraftReviewSurface = { kind: "none" } | InlineDraftReview;

/** What a toast says; the render layer owns the words. */
export type ReviewToastCode = "applied" | "discarded" | "change-gone";

export type ReviewToast = { id: number; code: ReviewToastCode; tone: "info" | "error" };

export type DraftReviewState = {
  surface: DraftReviewSurface;
  inlineReviewMessage: InlineReviewMessage | null;
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
      type: "reviewCleared";
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
  | {
      type: "draftCommandFailed";
      selection: DraftReviewSelection;
      code: Extract<InlineReviewMessageCode, "apply-failed" | "apply-unknown" | "discard-offline">;
    }
  | { type: "discardSucceeded"; draftId: string }
  | { type: "exitInline" }
  | { type: "exitReview" };

export const EMPTY_DRAFT_REVIEW_STATE: DraftReviewState = {
  surface: { kind: "none" },
  inlineReviewMessage: null,
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
        inlineReviewMessage: null,
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
    case "reviewCleared":
      if (!surfaceMatchesDraft(state.surface, action) || state.surface.kind !== "inline") {
        return state;
      }
      return state.surface.cleared
        ? state
        : {
            ...state,
            surface: { ...state.surface, cleared: { documentName: action.documentName } },
          };
    case "reviewReopened": {
      if (!surfaceMatchesDraft(state.surface, action) || state.surface.kind !== "inline") {
        return state;
      }
      const { cleared: _cleared, ...reopened } = state.surface;
      return state.surface.cleared ? { ...state, surface: reopened } : state;
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
    case "draftCommandFailed":
      return surfaceMatchesDraft(state.surface, action.selection)
        ? { ...state, inlineReviewMessage: { code: action.code, tone: "error" } }
        : state;
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
    inlineReviewMessage: currentDraftId === draftId ? null : state.inlineReviewMessage,
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

/** Leaving review: its messages go with it, and the next review starts with its marks showing. */
function clearInlineState(state: DraftReviewState): DraftReviewState {
  return { ...state, inlineReviewMessage: null, marksVisible: true };
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
