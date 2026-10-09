/** One command/state policy for Work-draft selection and disposition. */

import type { DraftApplyChangesResponse, DraftDiscardResponse } from "@meridian/contracts/drafts";
import {
  answerDraftSelection,
  beginChangeCommand,
  beginDraftBatch,
  beginDraftCommand,
  type ChangeFailureCode,
  type ChangeSelection,
  currentDraftCommandRecords,
  type DraftCommandFailure,
  failChangeCommand,
  failDraftCommand,
  type PendingDraftCommand,
  pendingDraftCommand,
  queueChangeSelection,
  releaseDraftCommand,
} from "@/client/query/draft-command-record";
import { classifyDraftCommandRejection } from "@/client/query/draft-command-rejection";
import type { ReviewFocus } from "./review-changes";

export type DraftCommandOutcome =
  | { kind: "blocked" }
  | { kind: "applied" }
  | { kind: "apply-outcome-unknown" }
  | { kind: "discarded" }
  /** A selection of changes was applied or discarded; the rest of the draft is untouched. */
  | { kind: "change-settled"; mode: "apply" | "discard" }
  /** A selection's command did not land; the reason is held on its changes. */
  | { kind: "change-refused"; mode: "apply" | "discard"; code: ChangeFailureCode }
  | { kind: "failed"; failure: DraftCommandFailure };

export type ChangeApplyRequest = {
  operationIds: string[];
  liveRevisionToken: string;
  draftRevisionToken: string;
};

/**
 * What the writer saw of the draft when they sent a selection: the tokens that
 * fence the request, and the generation the claim records (the tokens are not
 * an identity; the generation is).
 */
export type ChangeBasis = Pick<ChangeApplyRequest, "liveRevisionToken" | "draftRevisionToken"> & {
  draftGeneration: number;
};

export type DraftReviewCommandPorts = {
  /** The Work these commands act in; part of every command record's identity. */
  scope: { projectId: string; workId: string };
  /** Resolves once the server has confirmed Apply, or "unknown" when the response was lost. */
  apply: (
    selection: DraftReviewSelection,
    draftGeneration: number | undefined,
  ) => Promise<"applied" | "unknown">;
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
  /** The server confirmed a selection: drop its changes from the cached preview and refresh around them. */
  changeConfirmed: (
    selection: DraftReviewSelection,
    changes: ChangeSelection,
    mode: "apply" | "discard",
  ) => void;
  describeDraft: (
    selection: DraftReviewSelection,
    mode: "apply" | "discard",
    batch: boolean,
  ) => PendingDraftCommand;
  draftDiscardStarted: (selection: DraftReviewSelection) => void;
  draftSettled: (
    selection: DraftReviewSelection,
    draftGeneration: number | undefined,
    mode: "apply" | "discard",
  ) => void;
};

/**
 * The complete disposition command facade. React supplies I/O ports; this
 * session owns command sequencing, batches, and explicit navigation
 * callbacks.
 */
export class DraftReviewSession {
  constructor(private readonly ports: () => DraftReviewCommandPorts) {}

  async applyReviewedDraft(selection: DraftReviewSelection): Promise<DraftCommandOutcome> {
    return this.wholeCommand("apply", selection, this.ports());
  }

  /**
   * Apply a selection of changes (complete server closure classes) of one draft
   * to live. The changes leave every surface at once; a refusal or a lost
   * request brings them back with the reason held on them
   * (`draft-command-record`).
   */
  applySelection(
    draft: DraftReviewSelection,
    changes: ChangeSelection,
    basis: ChangeBasis,
    completesDraft = false,
  ): Promise<DraftCommandOutcome> {
    return this.changeCommand("apply", draft, changes, basis, completesDraft, (ports, request) =>
      ports.applyChanges(draft, request),
    );
  }

  /**
   * Discard a selection of changes: their operations go in a selective Discard,
   * the draft's text returns to live's. Fenced by the same tokens as Apply, and
   * answered the same way: `stale` brings the changes back; it never reads as a
   * discarded or closed draft.
   */
  discardSelection(
    draft: DraftReviewSelection,
    changes: ChangeSelection,
    basis: ChangeBasis,
    completesDraft = false,
  ): Promise<DraftCommandOutcome> {
    return this.changeCommand("discard", draft, changes, basis, completesDraft, (ports, request) =>
      ports.discardChanges(draft, request),
    );
  }

  async discardDraft(selection: DraftReviewSelection): Promise<DraftCommandOutcome> {
    return this.wholeCommand("discard", selection, this.ports());
  }

  async disposeDrafts(
    mode: "apply" | "discard",
    drafts: readonly DraftReviewSelection[],
  ): Promise<DraftCommandOutcome[]> {
    const ports = this.ports();
    return (
      await runDraftBatch(
        ports.scope,
        drafts.map((draft) => ({ draft, command: ports.describeDraft(draft, mode, true) })),
        ({ draft }) => this.wholeCommand(mode, draft, ports, true),
      )
    ).map(({ outcome }) => outcome);
  }

  /**
   * A selection's Apply or Discard. Both are answered by the same statuses
   * (`applied` or `discarded` confirms, `gone` drops the change with a word,
   * anything else brings it back with its reason), and a request that got no
   * answer is held as `unknown` for both: it may have landed, so it is never
   * read as a refusal and never inferred from the list.
   */
  private async changeCommand(
    mode: "apply" | "discard",
    selection: DraftReviewSelection,
    change: ChangeSelection,
    basis: ChangeBasis,
    completesDraft: boolean,
    send: (
      ports: DraftReviewCommandPorts,
      request: ChangeApplyRequest,
    ) => Promise<{ status: string } | "unknown">,
  ): Promise<DraftCommandOutcome> {
    const ports = this.ports();
    const draft = { ...ports.scope, ...selection };
    if (!beginChangeCommand(draft, change, mode, basis.draftGeneration, completesDraft))
      return { kind: "blocked" };
    try {
      let response: { status: string } | "unknown";
      try {
        response = await send(ports, {
          operationIds: [...change.operationIds],
          liveRevisionToken: basis.liveRevisionToken,
          draftRevisionToken: basis.draftRevisionToken,
        });
      } catch (error) {
        const rejection = classifyDraftCommandRejection(error);
        const code = rejection.kind === "refused" ? "refused" : rejection.kind;
        failChangeCommand(
          draft,
          change,
          mode,
          code,
          rejection.kind === "refused"
            ? { serverCode: rejection.serverCode, serverReason: rejection.serverReason }
            : undefined,
        );
        return { kind: "change-refused", mode, code };
      }
      if (response === "unknown") {
        failChangeCommand(draft, change, mode, "unknown");
        return { kind: "change-refused", mode, code: "unknown" };
      }
      if (response.status === (mode === "apply" ? "applied" : "discarded")) {
        answerDraftSelection(draft, mode === "apply" ? "applied" : "discarded");
        ports.changeConfirmed(selection, change, mode);
        return { kind: "change-settled", mode };
      }
      if (response.status === "gone") {
        // Nothing left to handle: the change leaves, with a word about it.
        answerDraftSelection(draft, "change-gone");
        ports.changeConfirmed(selection, change, mode);
        return { kind: "change-refused", mode, code: "gone" };
      }
      const code = response.status === "draft_only" ? "draft-only" : "stale";
      failChangeCommand(draft, change, mode, code);
      return { kind: "change-refused", mode, code };
    } finally {
      releaseDraftCommand(draft);
    }
  }

  private async wholeCommand(
    mode: "apply" | "discard",
    selection: DraftReviewSelection,
    ports: DraftReviewCommandPorts,
    batch = false,
  ): Promise<DraftCommandOutcome> {
    const draft = { ...ports.scope, ...selection };
    if (!batch && !beginDraftCommand(draft, ports.describeDraft(selection, mode, false)))
      return { kind: "blocked" };
    const generation = pendingDraftCommand(currentDraftCommandRecords(), draft)?.draftGeneration;
    try {
      // Navigation is explicit and optimistic, not inferred from settlement.
      if (mode === "discard") ports.draftDiscardStarted(selection);
      let result: "applied" | "unknown" | undefined;
      try {
        if (mode === "apply") result = await ports.apply(selection, generation);
        else await ports.discard(selection);
      } catch (error) {
        const failure = commandFailure(mode, error);
        failDraftCommand(draft, failure);
        return { kind: "failed", failure };
      }
      if (result === "unknown") {
        failDraftCommand(draft, { code: "apply-unknown" });
        return { kind: "apply-outcome-unknown" };
      }
      if (!batch) ports.draftSettled(selection, generation, mode);
      return { kind: mode === "apply" ? "applied" : "discarded" };
    } finally {
      releaseDraftCommand(draft);
    }
  }
}

export type DraftBatchItem = { draft: DraftReviewSelection } & (
  | { selection: ChangeSelection; command?: never }
  | { command: PendingDraftCommand; selection?: never }
);
export type DraftBatchOutcome = { draft: DraftReviewSelection; outcome: DraftCommandOutcome };

/** Both whole and selective batches pin their starting Work and expose one busy lifetime. */
export async function runDraftBatch<T extends DraftBatchItem>(
  scope: DraftReviewCommandPorts["scope"],
  items: readonly T[],
  send: (item: T) => Promise<DraftCommandOutcome>,
): Promise<DraftBatchOutcome[]> {
  if (!items.length) return [];
  const release = beginDraftBatch(scope);
  if (!release) return items.map(({ draft }) => ({ draft, outcome: { kind: "blocked" } }));
  const retires: (() => void)[] = [];
  const outcomes: DraftBatchOutcome[] = [];
  const blocked = new Set<number>();
  try {
    for (const [index, { draft, selection, command }] of items.entries()) {
      if (command) {
        if (beginDraftCommand({ ...scope, ...draft }, command))
          retires.push(() => {
            const target = { ...scope, ...draft };
            if (pendingDraftCommand(currentDraftCommandRecords(), target) === command)
              releaseDraftCommand(target);
          });
        else {
          blocked.add(index);
          retires.push(() => {});
        }
      } else
        retires.push(
          selection ? queueChangeSelection({ ...scope, ...draft }, selection) : () => {},
        );
    }
    for (const [index, item] of items.entries()) {
      const outcome = blocked.has(index)
        ? Promise.resolve<DraftCommandOutcome>({ kind: "blocked" })
        : send(item);
      if (item.selection) retires[index]?.();
      outcomes.push({ draft: item.draft, outcome: await outcome });
    }
    return outcomes;
  } finally {
    for (const retire of retires) retire();
    release();
  }
}

/** The failure a whole-draft Apply or Discard leaves, from the error its request threw. */
function commandFailure(mode: "apply" | "discard", error: unknown): DraftCommandFailure {
  const rejection = classifyDraftCommandRejection(error);
  switch (rejection.kind) {
    case "offline":
      return { code: `${mode}-offline` };
    case "server-error":
      return { code: `${mode}-server-error` };
    case "refused":
      return {
        code: `${mode}-refused`,
        serverCode: rejection.serverCode,
        ...(rejection.serverReason ? { serverReason: rejection.serverReason } : {}),
      };
  }
}

export type DraftReviewSelection = {
  documentId: string;
  draftId: string;
};

export type InlineDraftReview = {
  kind: "inline";
  previewIdentity?: string;
  /**
   * The draft generation the review shows (R): its room, its changes, the
   * editor's model and its completion all belong to it. Undefined until the
   * first read says (nothing was known on entry). It moves only through
   * `reenter`, and never down.
   */
  draftGeneration?: number;
  /** The review room of the draft, once a read has resolved it; the server's, never parsed. */
  roomName?: string;
  /** The room read failed; entering the draft again retries it. */
  roomError?: boolean;
  /**
   * The change (server closure class) the writer is looking at, if any, with
   * the operations it held when last seen: a class the server regroups keeps
   * some of them, which is how every surface finds the same change again
   * (`resolveFocusedChange`). One value for the whole review, kept current by
   * `useReconcileReviewFocus`; surfaces only read it.
   */
  focus?: ReviewFocus | null;
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

/**
 * A selection command's claim as a review reads it: the generation it acted on
 * and the completion it gives (none when it does not cover the draft's last
 * changes). The completion belongs to that generation and to no other.
 */
export type ReviewClaim = { draftGeneration: number; completion?: ReviewCompletion };

export type DraftReviewSurface = { kind: "none" } | InlineDraftReview;

/** What the draft's newest cached preview says: the generation it describes and whether it lists changes. */
export type ProposalEvidence = { draftGeneration: number; proposal: boolean };

/** What a toast says; the render layer owns the words. */
export type ReviewToastCode = "applied" | "discarded" | "change-gone";

export type ReviewToast = { id: number; code: ReviewToastCode; tone: "info" | "error" };

export type DraftReviewState = {
  surface: DraftReviewSurface;
  /** The header's "Show changes": false hides every mark in the manuscript. */
  marksVisible: boolean;
  toast: ReviewToast | null;
  toastSeq: number;
};

export type DraftReviewAction =
  | {
      type: "enterInline";
      documentId: string;
      draftId: string;
      /** The newest proposal the caches know of (the cached preview that lists changes, the list row). */
      draftGeneration?: number;
      /** A command already in flight on this draft (`draftClaim`). */
      claim?: ReviewClaim;
    }
  | { type: "inlineModelAvailable"; documentId: string; draftId: string; identity: string }
  | { type: "inlineShown"; documentId: string; draftId: string; shown: boolean }
  | {
      type: "reviewDisposed";
      documentId: string;
      draftId: string;
      draftGeneration: number | undefined;
    }
  | { type: "changeFocused"; documentId: string; draftId: string; focus: ReviewFocus | null }
  | {
      /** A preview or list read of the draft landed (rows O1-O4), or the room read resolved (P, with `roomName`). */
      type: "generationObserved";
      documentId: string;
      draftId: string;
      draftGeneration: number;
      /** The read lists changes: a list row always does, a preview when `reviewChangesOfPreview` is non-empty. */
      proposal: boolean;
      claim?: ReviewClaim;
      roomName?: string;
    }
  | {
      /**
       * The Work's draft list, once authoritative, has no row for the draft (row X). `evidence`
       * is changes observed in the cached preview or session-layer writer delivery.
       */
      type: "draftAbsentFromList";
      documentId: string;
      draftId: string;
      evidence: ProposalEvidence | null;
    }
  | { type: "roomFailed"; documentId: string; draftId: string }
  | { type: "roomStale"; documentId: string; draftId: string; roomName: string }
  | {
      type: "reviewCompleting";
      documentId: string;
      draftId: string;
      /** The generation of the claim (or the batch hold) this completion belongs to. */
      draftGeneration: number;
      mode: "apply" | "discard";
      documentName: string | null;
    }
  | {
      type: "reviewClosed";
      documentId: string;
      draftId: string;
      draftGeneration: number;
      documentName: string | null;
    }
  | { type: "reviewReopened"; documentId: string; draftId: string; draftGeneration: number }
  | { type: "marksVisible"; visible: boolean }
  | { type: "toast"; code: ReviewToastCode; tone: "info" | "error" }
  | { type: "toastDismissed"; id: number }
  | { type: "exitInline" }
  | { type: "exitReview" };

export const EMPTY_DRAFT_REVIEW_STATE: DraftReviewState = {
  surface: { kind: "none" },
  marksVisible: true,
  toast: null,
  toastSeq: 0,
};

export function draftReviewReducer(
  state: DraftReviewState,
  action: DraftReviewAction,
): DraftReviewState {
  switch (action.type) {
    case "enterInline": {
      const surface = inlineSurfaceForEnter(state.surface, action);
      return surface === state.surface ? state : { ...state, surface };
    }
    case "inlineModelAvailable":
      return stateAfterInlineModelAvailable(state, action);
    case "inlineShown":
      if (!surfaceMatchesDraft(state.surface, action) || state.surface.kind !== "inline") {
        return state;
      }
      if ((state.surface.shown ?? false) === action.shown) return state;
      return { ...state, surface: { ...state.surface, shown: action.shown } };
    case "reviewDisposed":
      if (!surfaceMatchesDraft(state.surface, action) || state.surface.kind !== "inline")
        return state;
      if (
        state.surface.draftGeneration !== undefined &&
        (action.draftGeneration === undefined ||
          action.draftGeneration < state.surface.draftGeneration)
      )
        return state;
      return clearInlineState({ ...state, surface: { kind: "none" } });
    case "changeFocused":
      if (!surfaceMatchesDraft(state.surface, action) || state.surface.kind !== "inline") {
        return state;
      }
      if (sameFocus(state.surface.focus ?? null, action.focus)) return state;
      return { ...state, surface: { ...state.surface, focus: action.focus } };
    case "generationObserved":
      return onInline(state, action, (review) => observeGeneration(review, action));
    case "draftAbsentFromList":
      return draftAbsentFromList(state, action);
    case "roomFailed":
      return onInline(state, action, (review) =>
        review.roomName === undefined ? { ...review, roomError: true } : review,
      );
    case "roomStale":
      // The signal belongs to the room it came from: a review that has moved
      // on (re-entered, or already asked for a new room) ignores it.
      return onInline(state, action, (review) => {
        if (review.roomName !== action.roomName) return review;
        const { roomName: _stale, ...asking } = review;
        return asking;
      });
    case "reviewCompleting":
      return onInline(state, action, (review) =>
        onClaim(review, action.draftGeneration, {
          // A prediction never overrides the server's answer.
          held: (current) => {
            const held = current.completion;
            if (held?.phase === "closed") return current;
            if (held?.mode === action.mode && held.documentName === action.documentName)
              return current;
            return {
              ...current,
              completion: {
                phase: "pending",
                mode: action.mode,
                documentName: action.documentName,
              },
            };
          },
          entering: { phase: "pending", mode: action.mode, documentName: action.documentName },
        }),
      );
    case "reviewClosed":
      return onInline(state, action, (review) =>
        onClaim(review, action.draftGeneration, {
          held: (current) =>
            current.completion?.phase === "closed"
              ? current
              : { ...current, completion: { phase: "closed", documentName: action.documentName } },
          entering: { phase: "closed", documentName: action.documentName },
        }),
      );
    case "reviewReopened":
      return onInline(state, action, (review) =>
        onClaim(review, action.draftGeneration, {
          // Only a prediction is withdrawn: what the server closed stays closed.
          held: (current) => {
            if (current.completion?.phase !== "pending") return current;
            const { completion: _completion, ...reopened } = current;
            return reopened;
          },
          entering: undefined,
        }),
      );
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

function sameFocus(left: ReviewFocus | null, right: ReviewFocus | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.classId !== right.classId) return false;
  return (
    left.operationIds.length === right.operationIds.length &&
    left.operationIds.every((id, index) => id === right.operationIds[index])
  );
}

/** Entering a draft that is already open keeps the review; it only retries a failed room read. */
function inlineSurfaceForEnter(
  current: DraftReviewSurface,
  entering: DraftReviewSelection & { draftGeneration?: number; claim?: ReviewClaim },
): DraftReviewSurface {
  if (surfaceMatchesDraft(current, entering)) {
    if (current.kind !== "inline" || !current.roomError) return current;
    const { roomError: _failed, ...retrying } = current;
    return retrying;
  }
  // The newest proposal known; a claim counts too (it acted on a proposal).
  const known = [entering.draftGeneration, entering.claim?.draftGeneration].filter(
    (generation) => generation !== undefined,
  );
  const generation = known.length > 0 ? Math.max(...known) : undefined;
  const completion = completionAt(entering.claim, generation);
  return {
    kind: "inline",
    documentId: entering.documentId,
    draftId: entering.draftId,
    ...(generation !== undefined ? { draftGeneration: generation } : {}),
    ...(completion ? { completion } : {}),
  };
}

/** A claim gives its completion to the generation it acted on, and to no other. */
function completionAt(
  claim: ReviewClaim | undefined,
  generation: number | undefined,
): ReviewCompletion | undefined {
  return claim && claim.draftGeneration === generation ? claim.completion : undefined;
}

/** Apply `change` to the open review the action names; any other state is untouched. */
function onInline(
  state: DraftReviewState,
  draft: DraftReviewSelection,
  change: (review: InlineDraftReview) => InlineDraftReview,
): DraftReviewState {
  if (state.surface.kind !== "inline" || !surfaceMatchesDraft(state.surface, draft)) return state;
  const prior = state.surface;
  const next = change(prior);
  if (next === prior) return state;
  // Re-entering a generation restores the marks, as entering a review does.
  const reentered =
    prior.draftGeneration !== undefined && next.draftGeneration !== prior.draftGeneration;
  return { ...state, marksVisible: reentered ? true : state.marksVisible, surface: next };
}

/**
 * The one transition that moves the shown generation: the review takes up
 * generation `generation` in place. Its completion is the claim's when the
 * claim acted on that generation and nothing otherwise; the focus is dropped,
 * and the room is the caller's (cleared when unknown, so a fresh read follows).
 */
function reenter(
  review: InlineDraftReview,
  generation: number,
  completion: ReviewCompletion | undefined,
  roomName: string | undefined,
): InlineDraftReview {
  const { completion: _left, focus: _focus, roomName: _room, roomError: _error, ...kept } = review;
  return {
    ...kept,
    draftGeneration: generation,
    ...(completion ? { completion } : {}),
    ...(roomName !== undefined ? { roomName } : {}),
  };
}

/** Rows C1-C5: a claim speaks for the generation it acted on, and for no other. */
function onClaim(
  review: InlineDraftReview,
  claimed: number,
  rule: {
    /** C = R: the claim changes the review's completion. */
    held: (review: InlineDraftReview) => InlineDraftReview;
    /** C > R (or R unknown): the completion the review is entered with. */
    entering: ReviewCompletion | undefined;
  },
): InlineDraftReview {
  const shown = review.draftGeneration;
  if (shown !== undefined && claimed < shown) return review;
  if (shown === undefined || claimed > shown)
    return reenter(review, claimed, rule.entering, undefined);
  return rule.held(review);
}

/** Rows O1-O4 and P: what a read of the draft means for the review showing it. */
function observeGeneration(
  review: InlineDraftReview,
  read: {
    draftGeneration: number;
    proposal: boolean;
    claim?: ReviewClaim;
    roomName?: string;
  },
): InlineDraftReview {
  const shown = review.draftGeneration;
  const withRoom = (current: InlineDraftReview): InlineDraftReview => {
    if (read.roomName === undefined) return current;
    if (current.roomName === read.roomName && !current.roomError) return current;
    const { roomError: _error, ...rest } = current;
    return { ...rest, roomName: read.roomName };
  };
  if (shown === undefined) {
    // Nothing was known on entry: the first read says what the review shows.
    const completion = completionAt(read.claim, read.draftGeneration);
    return withRoom({
      ...review,
      draftGeneration: read.draftGeneration,
      ...(completion ? { completion } : {}),
    });
  }
  if (read.draftGeneration < shown) return review;
  if (read.draftGeneration === shown) return withRoom(review);
  if (!adoptsGeneration(review, read)) return withRoom(review);
  const completion = completionAt(read.claim, read.draftGeneration);
  return reenter(review, read.draftGeneration, completion, read.roomName);
}

/**
 * Row X: the list has no row for the reviewed draft. With no completion (the
 * writer's own last change explains a missing row) that is an external close,
 * unless the preview or session layer shows changes at the shown generation
 * or a newer one: the draft is alive and the list lags. A newer generation is the
 * observer's to take up; deciding here, against R and the evidence together,
 * keeps the outcome independent of which read arrived first (invariant 4).
 */
function draftAbsentFromList(
  state: DraftReviewState,
  action: DraftReviewSelection & { evidence: ProposalEvidence | null },
): DraftReviewState {
  const review = state.surface;
  if (review.kind !== "inline" || !surfaceMatchesDraft(review, action) || review.completion) {
    return state;
  }
  const { evidence } = action;
  const alive =
    evidence?.proposal === true &&
    (review.draftGeneration === undefined || evidence.draftGeneration >= review.draftGeneration);
  return alive ? state : clearInlineState({ ...state, surface: { kind: "none" } });
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

/** A newer proposal, never an empty close-reset, re-enters the review. */
export function adoptsGeneration(
  review: InlineDraftReview,
  read: { draftGeneration: number; proposal: boolean },
) {
  return (
    review.draftGeneration !== undefined &&
    read.draftGeneration > review.draftGeneration &&
    read.proposal
  );
}
