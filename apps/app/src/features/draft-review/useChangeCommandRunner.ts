/** Selection commands use their caller’s creation-bound Work ports; reviews observe addressed outcomes. */
import { useCallback, useRef } from "react";
import type { ChangeSelection } from "@/client/query/draft-command-record";
import {
  type DraftCommandOutcome,
  type DraftReviewSelection,
  runDraftBatch,
} from "./draft-review-session";
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
  const scope = useRef(caller);
  scope.current = caller;
  const batch = useCallback(async (mode: "apply" | "discard", items: readonly DraftSelection[]) => {
    const from = scope.current;
    const command = mode === "apply" ? from.applyChanges : from.discardChanges;
    return runDraftBatch(
      { projectId: from.projectId, workId: from.workId },
      items,
      ({ draft, selection }) => command(draft, selection),
    );
  }, []);

  return {
    applyChanges: useCallback(
      (draft, selection) => scope.current.applyChanges(draft, selection),
      [],
    ),
    discardChanges: useCallback(
      (draft, selection) => scope.current.discardChanges(draft, selection),
      [],
    ),
    applyBatch: useCallback((items) => batch("apply", items), [batch]),
    discardBatch: useCallback((items) => batch("discard", items), [batch]),
  };
}
