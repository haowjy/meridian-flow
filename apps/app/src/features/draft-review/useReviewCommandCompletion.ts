/**
 * useReviewCommandCompletion — keeps an open review's completion ("Applying",
 * "Discarding", "No changes left") in step with the selection command in
 * flight on its draft, whichever controller sent it.
 *
 * A command's identity, mode and coverage live in the draft's claim, and the
 * server's answer lands there (`draft-command-record`), so the review needs
 * nothing from the sender. A review that opens on a claimed draft adopts its
 * pending completion at once (`commandCompletion`); one already open follows
 * the claim: pending when it begins, closed on the answer that closed the
 * draft (before any list read can drop the draft), and withdrawn when the
 * claim ends without that answer (a refusal, a lost request, a change that did
 * not close the draft).
 */

import { useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useEffect } from "react";
import {
  type DraftCommandRecords,
  pendingChangeCommand,
  subscribeDraftCommandRecords,
} from "@/client/query/draft-command-record";
import type {
  DraftReviewAction,
  DraftReviewSelection,
  DraftReviewState,
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
  const command = pendingChangeCommand(records, draft);
  if (command?.draftClosed) return { phase: "closed", documentName: documentName() };
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
  const command = pendingChangeCommand(records, draft);
  const before = pendingChangeCommand(previous, draft);
  if (command === before) return null;
  const { documentId, draftId } = draft;
  if (command?.draftClosed)
    return { type: "reviewClosed", documentId, draftId, documentName: documentName() };
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
  stateRef,
  activeRef,
  dispatch,
}: Scope & {
  stateRef: { readonly current: DraftReviewState };
  activeRef: { readonly current: boolean };
  dispatch: Dispatch<DraftReviewAction>;
}): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeDraftCommandRecords((records, previous) => {
        const surface = stateRef.current.surface;
        if (surface.kind !== "inline" || !activeRef.current) return;
        const action = completionAction(
          records,
          previous,
          { projectId, workId, documentId: surface.documentId, draftId: surface.draftId },
          // Read now: the draft leaves the list once the answer's reads land.
          () => listedDocumentName(queryClient, projectId, workId, surface.draftId),
        );
        if (action) dispatch(action);
      }),
    [projectId, workId, queryClient, stateRef, activeRef, dispatch],
  );
}
