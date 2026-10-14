/** useDraftReviewController: shared state machine for reviewing AI document drafts. */

import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useCallback, useMemo, useReducer, useRef } from "react";
import type { DraftCommandOutcome } from "@/client/query/draft-command-executor";
import {
  clearDraftReviewLaunchFailure,
  dismissOverrode,
  draftOverrode,
  type Overrode,
  pendingDraftCommand,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { isWholeItem, useDraftMeta } from "@/client/query/useDraftMeta";
import { discardAll, discardChange } from "./draft-discard";
import {
  type DraftReviewSelection,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  inlineReviewFromState,
} from "./draft-review-session";
import { baseKeyOf, type ReviewFrame } from "./review-frame";
import type { ReviewChange } from "./review-model";
import { type EditorRef, reviewRuntimeOf } from "./review-runtime";
import { prepareFromFrame } from "./useDraftApply";
import { type CommandStart, useWorkDraftCommands } from "./useWorkDraftCommands";

export type { DraftReviewSelection, InlineDraftReview };

export type DraftReviewStateOwner = Readonly<{
  state: typeof EMPTY_DRAFT_REVIEW_STATE;
  dispatch: Dispatch<Parameters<typeof draftReviewReducer>[1]>;
}>;

const NO_OVERRODE: Overrode = [];

export function useDraftReviewStateOwner(): DraftReviewStateOwner {
  const [state, dispatch] = useReducer(draftReviewReducer, EMPTY_DRAFT_REVIEW_STATE);
  return { state, dispatch };
}

export type DraftReviewController = {
  projectId: string;
  workId: string;
  /** Focused thread owning this review surface; threads Apply cache invalidation. */
  threadId: string | null;
  inlineReview: InlineDraftReview | null;
  reviewRoomError: boolean;
  /** A whole-draft Apply is in flight on the open draft. */
  isApplying: boolean;
  canApplyReviewedDraft: boolean;
  /** A whole-draft command is in flight on the open draft. */
  isDisposing: boolean;
  /** Every Apply and Discard control disables on this: the Work is archived and its drafts are frozen. */
  dispositionLocked: boolean;
  changesLocked: boolean;
  /** The header's "Show changes". The editor paints from it (`useInlineReviewFocus`). */
  marksVisible: boolean;
  setMarksVisible: (visible: boolean) => void;
  /** The change (group id) the writer is looking at in the open review, or null. */
  focus: string | null;
  /** Record the focused change without touching the manuscript (a click on a mark). */
  reportFocusedChange: (review: DraftReviewSelection, changeId: string | null) => void;
  /**
   * Focus one change in the manuscript and in every list. `scroll` brings it into view. `review` is the
   * review the caller meant: a caller that waited may find another open, and then nothing happens.
   */
  focusReviewChange: (
    review: DraftReviewSelection,
    changeId: string,
    options?: { scroll?: boolean; instant?: boolean },
  ) => void;
  /** Live text the last Apply of the open draft replaced because both sides changed the same words; dismissible. */
  appliedOver: Overrode;
  dismissAppliedOver: () => void;
  /** Whether the open item is one whole change (a created, binary or live-deleted item): only item-level commands act on it. */
  wholeItem: boolean;
  enterInlineReview: (documentId: string, itemKey: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  inlineReviewModelAvailable: (identity: string, documentId: string, itemKey: string) => void;
  /** The review editor reports when its body is (or stops being) the painted one. */
  setInlineReviewShown: (documentId: string, itemKey: string, shown: boolean) => void;
  /** Apply this change of the open review, as the frame its row was drawn from showed it (it leaves the screen at once). */
  applyOpenChange: (change: ReviewChange) => Promise<DraftCommandOutcome>;
  /**
   * Discard one change of the open review: a local edit of `editor` (the one the writer clicked in; a row
   * that sits in no editor names none and takes the longest-attached), undone by that editor's Ctrl+Z.
   */
  discardOpenChange: (change: ReviewChange, editor?: EditorRef | null) => "discarded" | "stale";
  /** Apply the whole draft (stays open and empty), as `frame` showed it when the writer clicked. */
  apply: (
    documentId: string,
    itemKey: string,
    frame?: ReviewFrame | null,
  ) => Promise<DraftCommandOutcome>;
  /** Discard the whole draft: one local edit for a prose draft, item Discard for a new document. */
  discard: (
    documentId: string,
    itemKey: string,
    editor?: EditorRef | null,
  ) => Promise<DraftCommandOutcome>;
  startDraft: (
    mode: "apply" | "discard",
    draft: DraftReviewSelection,
    from?: { frame?: ReviewFrame | null; editor?: EditorRef | null },
  ) => CommandStart;
  disposeDrafts: (
    mode: "apply" | "discard",
    drafts: readonly DraftReviewSelection[],
  ) => Promise<DraftCommandOutcome[]>;
};

export function useDraftReviewController({
  projectId,
  work,
  threadId = null,
  stateOwner,
}: {
  projectId: string;
  /** The Work whose drafts this surface reviews; null scopes nothing. */
  work: Work | null;
  threadId?: string | null;
  stateOwner: DraftReviewStateOwner;
}): DraftReviewController {
  const workId = work?.id ?? "";
  const queryClient = useQueryClient();
  const { state, dispatch } = stateOwner;
  const commands = useWorkDraftCommands({ projectId, work, threadId });
  const stateRef = useRef(state);
  stateRef.current = state;

  const inlineReview = inlineReviewFromState(state);
  /** The runtime of a draft of this Work; only the draft that is open may be acted on. */
  const runtimeOf = useCallback(
    (review: DraftReviewSelection) =>
      reviewRuntimeOf({
        projectId,
        workId,
        documentId: review.documentId,
        itemKey: review.itemKey,
      }),
    [projectId, workId],
  );

  const { meta } = useDraftMeta(inlineReview ? { projectId, workId, ...inlineReview } : null, {
    enabled: inlineReview !== null,
  });
  // A created, binary or live-deleted item is one whole change: it is applied and closed as an item.
  const wholeItem = meta !== null && meta.kind !== "gone" && meta.wholeItem;

  const records = useDraftCommandRecords();
  const activeCommand = inlineReview
    ? pendingDraftCommand(records, { projectId, workId, ...inlineReview })
    : null;
  const isApplying = activeCommand?.mode === "apply";
  const isDisposing = activeCommand !== null;
  const canApplyReviewedDraft = inlineReview?.previewIdentity !== undefined;

  const enterInlineReview = useCallback(
    (documentId: string, itemKey: string) => {
      clearDraftReviewLaunchFailure({ projectId, workId, documentId, itemKey });
      dispatch({ type: "enterInline", documentId, itemKey });
    },
    [projectId, workId, dispatch],
  );
  const exitInlineReview = useCallback(() => dispatch({ type: "exitInline" }), [dispatch]);
  const exitReview = useCallback(() => dispatch({ type: "exitReview" }), [dispatch]);
  const inlineReviewModelAvailable = useCallback(
    (identity: string, documentId: string, itemKey: string) =>
      dispatch({ type: "inlineModelAvailable", identity, documentId, itemKey }),
    [dispatch],
  );
  const setInlineReviewShown = useCallback(
    (documentId: string, itemKey: string, shown: boolean) =>
      dispatch({ type: "inlineShown", documentId, itemKey, shown }),
    [dispatch],
  );
  const setMarksVisible = useCallback(
    (visible: boolean) => dispatch({ type: "marksVisible", visible }),
    [dispatch],
  );

  const reportFocusedChange = useCallback(
    (review: DraftReviewSelection, changeId: string | null) =>
      dispatch({ type: "changeFocused", ...review, focus: changeId }),
    [dispatch],
  );
  const focusReviewChange = useCallback(
    (
      review: DraftReviewSelection,
      changeId: string,
      options?: { scroll?: boolean; instant?: boolean },
    ) => {
      // The identity is checked before anything is touched: the open review, and the editor showing it,
      // are the ones this focus was meant for.
      const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
      if (inline?.documentId !== review.documentId || inline.itemKey !== review.itemKey) return;
      reportFocusedChange(review, changeId);
      const editor = runtimeOf(review)?.editorHandle()?.editor;
      if (!editor || editor.isDestroyed) return;
      editor.commands.setReviewActiveChange(changeId);
      if (options?.scroll)
        editor.commands.scrollReviewChangeIntoView(changeId, { instant: options.instant });
    },
    [reportFocusedChange, runtimeOf],
  );

  // What an Apply overrode in live is published per draft by the command lifecycle, whichever surface applied.
  const appliedOver: Overrode = inlineReview
    ? draftOverrode(records, { projectId, workId, ...inlineReview })
    : NO_OVERRODE;
  const dismissAppliedOver = useCallback(() => {
    if (inlineReview) dismissOverrode({ projectId, workId, ...inlineReview });
  }, [projectId, workId, inlineReview]);

  const applyOpenChange = useCallback(
    async (change: ReviewChange): Promise<DraftCommandOutcome> => {
      if (!inlineReview) return { kind: "blocked" };
      const draft = { documentId: inlineReview.documentId, itemKey: inlineReview.itemKey };
      const { frame } = change;
      if (!frame) return { kind: "blocked" };
      const prepare = prepareFromFrame({ projectId, workId, ...draft }, frame);
      // A whole-item item's one change is the item: a per-change Apply would answer `whole_item`.
      if (wholeItem) return commands.applyDraft(draft, prepare).outcome;
      return commands.applyChanges(
        draft,
        [{ id: change.id, pin: change.pin }],
        baseKeyOf(frame),
        prepare,
      );
    },
    [commands.applyChanges, commands.applyDraft, inlineReview, projectId, workId, wholeItem],
  );

  const startDraft = useCallback(
    (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      from?: { frame?: ReviewFrame | null; editor?: EditorRef | null },
    ): CommandStart => {
      const runtime = runtimeOf(draft);
      if (mode === "apply") {
        // A control in an open editor applies what that editor shows now: typed words the projection has not
        // caught up with included. Without an editor it is the frame the writer's button was drawn from; with
        // neither, the draft is read from its room.
        const open = from?.editor ? runtime?.editorHandle(from.editor) : null;
        const frame = open?.projectNow() ?? from?.frame ?? null;
        return frame
          ? commands.applyDraft(draft, prepareFromFrame({ projectId, workId, ...draft }, frame))
          : commands.applyDraft(draft);
      }
      // A text item's Discard is a local edit that Ctrl+Z undoes; only a whole item (created, binary or
      // live-deleted) has no base to return to and is closed. A text item with no editor attached is never
      // closed on the server: that cannot be undone, so the Discard waits for its room.
      if (!isWholeItem(queryClient, { projectId, workId, ...draft })) {
        const handle = runtime?.editorHandle(from?.editor ?? undefined);
        if (!handle || commands.dispositionLocked)
          return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
        const result = discardAll(handle);
        return {
          sent: result === "discarded",
          outcome: Promise.resolve(
            result === "discarded" ? { kind: "discarded" } : { kind: "blocked" },
          ),
        };
      }
      const start = commands.discardDraft(draft);
      return {
        ...start,
        outcome: start.outcome.then((outcome) => {
          if (outcome.kind === "discarded" || outcome.kind === "gone")
            dispatch({ type: "reviewDisposed", ...draft });
          return outcome;
        }),
      };
    },
    [commands, queryClient, dispatch, runtimeOf, projectId, workId],
  );
  const discardOpenChange = useCallback(
    (change: ReviewChange, editor?: EditorRef | null): "discarded" | "stale" => {
      if (!inlineReview || commands.dispositionLocked) return "stale";
      // A whole-item item has no base to return to: its Discard closes the item (item Discard).
      if (wholeItem) {
        startDraft("discard", inlineReview);
        return "discarded";
      }
      const handle = runtimeOf(inlineReview)?.editorHandle(editor ?? undefined);
      return handle && change.frame ? discardChange(handle, change.frame, change.id) : "stale";
    },
    [commands.dispositionLocked, inlineReview, runtimeOf, startDraft, wholeItem],
  );

  const apply = useCallback(
    (documentId: string, itemKey: string, frame?: ReviewFrame | null) =>
      startDraft("apply", { documentId, itemKey }, { frame }).outcome,
    [startDraft],
  );
  const discard = useCallback(
    (documentId: string, itemKey: string, editor?: EditorRef | null) =>
      startDraft("discard", { documentId, itemKey }, { editor }).outcome,
    [startDraft],
  );

  return useMemo(
    () => ({
      projectId,
      workId,
      threadId,
      inlineReview,
      reviewRoomError: inlineReview?.roomError ?? false,
      isApplying,
      canApplyReviewedDraft,
      isDisposing,
      dispositionLocked: commands.dispositionLocked,
      changesLocked: commands.changesLocked,
      marksVisible: state.marksVisible,
      setMarksVisible,
      focus: inlineReview?.focus ?? null,
      reportFocusedChange,
      focusReviewChange,
      appliedOver,
      dismissAppliedOver,
      wholeItem,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      setInlineReviewShown,
      applyOpenChange,
      discardOpenChange,
      apply,
      discard,
      startDraft,
      disposeDrafts: commands.disposeDrafts,
    }),
    [
      projectId,
      workId,
      threadId,
      inlineReview,
      isApplying,
      canApplyReviewedDraft,
      isDisposing,
      commands.dispositionLocked,
      commands.changesLocked,
      commands.disposeDrafts,
      state.marksVisible,
      setMarksVisible,
      reportFocusedChange,
      focusReviewChange,
      appliedOver,
      dismissAppliedOver,
      wholeItem,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      setInlineReviewShown,
      applyOpenChange,
      discardOpenChange,
      apply,
      discard,
      startDraft,
    ],
  );
}
