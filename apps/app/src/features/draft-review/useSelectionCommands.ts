/**
 * useSelectionCommands — one controller's Apply and Discard of a selection of
 * changes on any draft of its Work.
 *
 * The command reads the draft's cached preview for the revision tokens the
 * writer saw; with no active preview there is nothing they saw to send, and the
 * selection is refused as out of date. The command's coverage of the draft's
 * last changes rides on its claim, so any review showing the draft follows it
 * (`useReviewCommandCompletion`). The toast is this controller's open review's.
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
      // The last changes handled: nothing is finished until the command's own
      // answer says so, but the writer's click shows at once as a pending
      // completion, on whichever review has the draft open. It rides on the
      // draft's claim (`useReviewCommandCompletion`), so a refused duplicate
      // never holds or withdraws it.
      const handlesLast =
        cached?.status === "active" &&
        coversEveryChange(selection, reviewChanges(cached.operations, cached.hunks));
      let outcome: DraftCommandOutcome;
      if (cached?.status === "active") {
        const tokens = {
          liveRevisionToken: cached.liveRevisionToken,
          draftRevisionToken: cached.draftRevisionToken,
        };
        outcome = await (mode === "apply"
          ? session.applySelection(draft, selection, tokens, handlesLast)
          : session.discardSelection(draft, selection, tokens, handlesLast));
      } else {
        // Without a preview there is nothing the writer saw to apply or discard: out of date.
        outcome = { kind: "change-refused", mode, code: "stale" };
      }
      if (!activeRef.current) return outcome;
      // The toast belongs to the review the writer is in when the answer comes,
      // not the one they were in at the click; a row elsewhere shows its own result.
      const surface = stateRef.current.surface;
      const open =
        surface.kind === "inline" &&
        surface.documentId === draft.documentId &&
        surface.draftId === draft.draftId;
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
