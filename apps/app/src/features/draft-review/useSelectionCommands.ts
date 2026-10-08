/**
 * useSelectionCommands — one controller's Apply and Discard of a selection of
 * changes on any draft of its Work.
 *
 * The command reads the draft's cached preview for the revision tokens the
 * writer saw; with no active preview there is nothing they saw to send, and the
 * selection is refused as out of date. Completion (`reviewCompleting`, `reviewReopened`,
 * and the answer's `reviewClosed` through the mutation's `onAnswered`) runs
 * only when the draft is this controller's open inline review: any other draft
 * has no review state to settle, and its rows leave through the command record.
 */
import type { DraftPreviewResponse, ThreadDraftListItem } from "@meridian/contracts/drafts";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useCallback } from "react";
import type { ChangeSelection } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { coversEveryChange } from "./change-selection";
import type {
  DraftCommandOutcome,
  DraftReviewAction,
  DraftReviewSelection,
  DraftReviewSession,
  DraftReviewState,
} from "./draft-review-session";
import { reviewChanges } from "./review-changes";

export type SelectionCommand = (
  draft: DraftReviewSelection,
  selection: ChangeSelection,
) => Promise<DraftCommandOutcome>;

export function useSelectionCommands({
  projectId,
  workId,
  session,
  stateRef,
  activeRef,
  dispatch,
}: {
  projectId: string;
  workId: string;
  session: DraftReviewSession;
  stateRef: { readonly current: DraftReviewState };
  activeRef: { readonly current: boolean };
  dispatch: Dispatch<DraftReviewAction>;
}): { applyChanges: SelectionCommand; discardChanges: SelectionCommand } {
  const queryClient = useQueryClient();

  const run = useCallback(
    async (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      selection: ChangeSelection,
    ): Promise<DraftCommandOutcome> => {
      // A selection with no operation of its own (an unclassified hunk) has nothing to send.
      if (selection.operationIds.length === 0) return { kind: "blocked" };
      const cached = queryClient.getQueryData<DraftPreviewResponse>(
        projectQueryKeys.workDraftPreview(projectId, workId, draft.documentId, draft.draftId),
      );
      const surface = stateRef.current.surface;
      const open =
        surface.kind === "inline" &&
        surface.documentId === draft.documentId &&
        surface.draftId === draft.draftId;
      // Read before the command: it may be the one that takes the draft out of the list.
      const documentName = open
        ? listedDocumentName(queryClient, projectId, workId, draft.draftId)
        : null;
      // The last changes handled: nothing is finished until the command's own
      // answer says so (`settleAnsweredCommand`), but the writer's click shows
      // at once as a pending completion. A last Discard leaves live as it is,
      // so the finished text is already on screen: hold that inert at the
      // click, since waiting would show the review room merging the server's
      // reset (the discarded text doubled). A last Apply keeps the review
      // room, marks gone, until the answer: live has no change in it until then.
      const handlesLast =
        open &&
        cached?.status === "active" &&
        coversEveryChange(selection, reviewChanges(cached.operations, cached.hunks));
      if (handlesLast) {
        dispatch({ type: "reviewCompleting", ...draft, mode, documentName });
      }
      let outcome: DraftCommandOutcome;
      if (cached?.status === "active") {
        const tokens = {
          liveRevisionToken: cached.liveRevisionToken,
          draftRevisionToken: cached.draftRevisionToken,
        };
        outcome = await (mode === "apply"
          ? session.applySelection(draft, selection, tokens)
          : session.discardSelection(draft, selection, tokens));
      } else {
        // Without a preview there is nothing the writer saw to apply or discard: out of date.
        outcome = { kind: "change-refused", mode, code: "stale" };
      }
      if (!activeRef.current) return outcome;
      if (handlesLast && outcome.kind !== "change-settled") {
        // The command did not land (or the change was already gone): the
        // change is back, and so is the review of it. A change that landed was
        // answered by `settleAnsweredCommand`, closed or not.
        dispatch({ type: "reviewReopened", ...draft });
      }
      // The toast belongs to the review the writer is in; a row elsewhere shows its own result.
      if (open && outcome.kind === "change-settled") {
        dispatch({
          type: "toast",
          code: outcome.mode === "apply" ? "applied" : "discarded",
          tone: "info",
        });
      } else if (open && outcome.kind === "change-refused" && outcome.code === "gone") {
        dispatch({ type: "toast", code: "change-gone", tone: "error" });
      }
      return outcome;
    },
    [projectId, queryClient, session, workId, stateRef, activeRef, dispatch],
  );

  const applyChanges = useCallback<SelectionCommand>(
    (draft, selection) => run("apply", draft, selection),
    [run],
  );
  const discardChanges = useCallback<SelectionCommand>(
    (draft, selection) => run("discard", draft, selection),
    [run],
  );
  return { applyChanges, discardChanges };
}

/** The listed draft's document name, kept by a review that outlives the draft's place in the list. */
export function listedDocumentName(
  queryClient: QueryClient,
  projectId: string,
  workId: string,
  draftId: string,
): string | null {
  const listed = queryClient
    .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(projectId, workId))
    ?.find((item) => item.draftId === draftId);
  return listed?.documentName ?? null;
}
