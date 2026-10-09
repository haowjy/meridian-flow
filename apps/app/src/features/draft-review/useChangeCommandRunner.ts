/**
 * useChangeCommandRunner — the one way a surface sends Apply or Discard for a
 * selection of changes (the chat strip, a Work page row), so it never picks a
 * controller itself.
 *
 * A review's pending state, answer and completion belong to the controller
 * that has the draft open, and a last Discard must freeze the finished text
 * before the review room's reset. So a draft that is the Editor's open review
 * runs through the Editor's controller; any other draft runs through the
 * caller's own scope. Which one is decided when each command is sent, not when
 * the surface rendered.
 *
 * A batch is one command per draft, in order. Every draft gets its turn: a
 * refusal (or a draft another command holds) on one does not stop the next,
 * and each outcome is reported for its own draft. Nothing navigates. It is not
 * `disposeDrafts`, which applies or discards whole drafts under one batch
 * lifecycle (Apply all, Discard all).
 */

import { useCallback, useRef } from "react";
import type { ChangeSelection } from "@/client/query/draft-command-record";
import { useEditorDraftReview } from "./DraftReviewProvider";
import type { DraftCommandOutcome, DraftReviewSelection } from "./draft-review-session";
import type { DraftReviewController } from "./useDraftReviewController";

/** One draft's share of a batch: the draft and the changes of it to act on. */
export type DraftSelection = { draft: DraftReviewSelection; selection: ChangeSelection };

export type DraftSelectionOutcome = { draft: DraftReviewSelection; outcome: DraftCommandOutcome };

export type ChangeCommandRunner = {
  applyChanges: (
    draft: DraftReviewSelection,
    selection: ChangeSelection,
  ) => Promise<DraftCommandOutcome>;
  discardChanges: (
    draft: DraftReviewSelection,
    selection: ChangeSelection,
  ) => Promise<DraftCommandOutcome>;
  applyBatch: (items: readonly DraftSelection[]) => Promise<DraftSelectionOutcome[]>;
  discardBatch: (items: readonly DraftSelection[]) => Promise<DraftSelectionOutcome[]>;
};

export function useChangeCommandRunner(caller: DraftReviewController): ChangeCommandRunner {
  const editor = useEditorDraftReview().controller;
  const scopes = useRef({ caller, editor });
  scopes.current = { caller, editor };

  // `from` is the scope the command was started from: a batch keeps it for
  // every draft, so a caller that moves to another Work mid-batch cannot
  // redirect the remaining commands (its commands are bound to its own Work and
  // session). The Editor's scope is read fresh, and owns a draft only within
  // that Work.
  const run = useCallback(
    (
      from: DraftReviewController,
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      selection: ChangeSelection,
    ) => {
      const { editor } = scopes.current;
      const open = editor.inlineReview;
      const opensInEditor =
        editor.projectId === from.projectId &&
        editor.workId === from.workId &&
        open?.documentId === draft.documentId &&
        open.draftId === draft.draftId;
      const owner = opensInEditor ? editor : from;
      return mode === "apply"
        ? owner.applyChanges(draft, selection)
        : owner.discardChanges(draft, selection);
    },
    [],
  );

  const batch = useCallback(
    async (mode: "apply" | "discard", items: readonly DraftSelection[]) => {
      const from = scopes.current.caller;
      const outcomes: DraftSelectionOutcome[] = [];
      for (const { draft, selection } of items) {
        outcomes.push({ draft, outcome: await run(from, mode, draft, selection) });
      }
      return outcomes;
    },
    [run],
  );

  return {
    applyChanges: useCallback(
      (draft, selection) => run(scopes.current.caller, "apply", draft, selection),
      [run],
    ),
    discardChanges: useCallback(
      (draft, selection) => run(scopes.current.caller, "discard", draft, selection),
      [run],
    ),
    applyBatch: useCallback((items) => batch("apply", items), [batch]),
    discardBatch: useCallback((items) => batch("discard", items), [batch]),
  };
}
