/**
 * useReviewCommandCompletion — keeps an open review's completion ("Applying",
 * "Discarding", "No changes left") in step with the selection command in
 * flight on its draft, whichever controller sent it.
 *
 * A command's identity, mode and coverage live in the draft's claim, and the
 * server's answer lands there (`draft-command-record`), so the review needs
 * nothing from the sender. A review that opens on a claimed draft adopts its
 * pending completion at once (`commandCompletion`), or its closed one when the
 * answer already came; one already open follows the claim: pending when it
 * begins, closed on the answer that closed the draft (before any list read can
 * drop the draft), and withdrawn when the claim ends without that answer (a
 * refusal, a lost request, a change that did not close the draft).
 *
 * Every change to a claim of the Work is dispatched, whichever review is
 * rendered: the reducer applies it in order with the review's own transitions
 * (`enterInline`) and ignores it when it names another draft, so a draft
 * entered and answered in one flush still settles.
 */

import { useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useEffect } from "react";
import {
  changedDrafts,
  closedByCommand,
  type DraftCommandRecords,
  pendingChangeCommand,
  subscribeDraftCommandRecords,
} from "@/client/query/draft-command-record";
import type {
  DraftReviewAction,
  DraftReviewSelection,
  ReviewCompletion,
} from "./draft-review-session";
import { listedDocumentName } from "./useSelectionCommands";

type Scope = { projectId: string; workId: string };

/** The completion the command in flight on this draft gives a review that opens on it, if any. */
export function commandCompletion(
  records: DraftCommandRecords,
  draft: Scope & DraftReviewSelection,
  documentName: () => string | null,
): ReviewCompletion | undefined {
  const closed = closedByCommand(records, draft);
  if (closed) return { phase: "closed", documentName: closed.documentName };
  const command = pendingChangeCommand(records, draft);
  if (command?.completesDraft)
    return { phase: "pending", mode: command.mode, documentName: documentName() };
  return undefined;
}

/**
 * What a change to the draft's claim means for the review showing it. The
 * answer that closed the draft says so even for a command that did not look
 * like the last (another writer's change handled the rest).
 */
export function completionAction(
  records: DraftCommandRecords,
  previous: DraftCommandRecords,
  draft: Scope & DraftReviewSelection,
  documentName: () => string | null,
): DraftReviewAction | null {
  const { documentId, draftId } = draft;
  const closed = closedByCommand(records, draft);
  if (closed)
    return closedByCommand(previous, draft)
      ? null
      : { type: "reviewClosed", documentId, draftId, documentName: closed.documentName };
  const command = pendingChangeCommand(records, draft);
  const before = pendingChangeCommand(previous, draft);
  if (command === before) return null;
  if (command?.completesDraft)
    return {
      type: "reviewCompleting",
      documentId,
      draftId,
      mode: command.mode,
      documentName: documentName(),
    };
  // Only a prediction is withdrawn (the reducer keeps what the server closed).
  return before?.completesDraft ? { type: "reviewReopened", documentId, draftId } : null;
}

export function useReviewCommandCompletion({
  projectId,
  workId,
  activeRef,
  dispatch,
}: Scope & {
  activeRef: { readonly current: boolean };
  dispatch: Dispatch<DraftReviewAction>;
}): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeDraftCommandRecords((records, previous) => {
        if (!activeRef.current) return;
        for (const draft of changedDrafts(records, previous, { projectId, workId })) {
          const action = completionAction(
            records,
            previous,
            draft,
            // Read now: the draft leaves the list once the answer's reads land.
            () => listedDocumentName(queryClient, projectId, workId, draft.draftId),
          );
          if (action) dispatch(action);
        }
      }),
    [projectId, workId, queryClient, activeRef, dispatch],
  );
}
