/** State policy for the selected draft review and its generation. */
import type { ReviewFocus } from "./review-changes";

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
       * A list omission, gone preview or unavailable room (row X). Evidence
       * includes cached changes and pending writer delivery at its generation.
       */
      type: "reviewAbsent";
      documentId: string;
      draftId: string;
      /** The generation addressed by the absent read; older absence cannot close R. */
      draftGeneration?: number;
      evidence: ProposalEvidence | null;
      draftOnly?: boolean;
      /** A terminal session or failed rebuild is not a transient missing read. */
      terminal?: boolean;
    }
  | { type: "roomFailed"; documentId: string; draftId: string }
  | { type: "roomStale"; documentId: string; draftId: string; roomName: string }
  | (DraftReviewSelection & {
      type: "completionObserved";
      draftGeneration: number;
      completion: ReviewCompletion | null;
    })
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
    case "reviewAbsent":
      return reviewAbsent(state, action);
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
    case "completionObserved":
      return onInline(state, action, (review) => observeCompletion(review, action));
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
function observeCompletion(
  review: InlineDraftReview,
  observed: { draftGeneration: number; completion: ReviewCompletion | null },
): InlineDraftReview {
  const shown = review.draftGeneration;
  if (shown !== undefined && observed.draftGeneration < shown) return review;
  if (shown === undefined || observed.draftGeneration > shown)
    return reenter(review, observed.draftGeneration, observed.completion ?? undefined, undefined);
  const held = review.completion;
  const next = observed.completion;
  if (held?.phase === "closed") return review;
  if (!next) {
    if (!held) return review;
    const { completion: _completion, ...reopened } = review;
    return reopened;
  }
  if (
    held?.phase === next.phase &&
    held.documentName === next.documentName &&
    next.phase === "pending" &&
    held.mode === next.mode
  )
    return review;
  return { ...review, completion: next };
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
  if (!adoptsGeneration(review, read)) return withRoom(review);
  const completion = completionAt(read.claim, read.draftGeneration);
  return reenter(review, read.draftGeneration, completion, read.roomName);
}

/**
 * Row X: absence below the shown generation is stale. With no completion (the
 * writer's own last change explains a missing row) that is an external close,
 * unless the preview or session layer shows changes at the shown generation
 * or a newer one: the draft is alive and the list lags. A newer generation is the
 * observer's to take up; deciding here, against R and the evidence together,
 * keeps the outcome independent of which read arrived first (invariant 4).
 */
function reviewAbsent(
  state: DraftReviewState,
  action: Extract<DraftReviewAction, { type: "reviewAbsent" }>,
): DraftReviewState {
  const review = state.surface;
  if (
    review.kind !== "inline" ||
    !surfaceMatchesDraft(review, action) ||
    (!action.terminal &&
      (review.completion ||
        (action.draftGeneration !== undefined &&
          review.draftGeneration !== undefined &&
          action.draftGeneration < review.draftGeneration)))
  ) {
    return state;
  }
  const { evidence } = action;
  const alive =
    evidence?.proposal === true &&
    (review.draftGeneration === undefined || evidence.draftGeneration >= review.draftGeneration);
  if (alive && !action.terminal) return state;
  return action.draftOnly
    ? review.roomError
      ? state
      : { ...state, surface: { ...review, roomName: undefined, roomError: true } }
    : clearInlineState({ ...state, surface: { kind: "none" } });
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
