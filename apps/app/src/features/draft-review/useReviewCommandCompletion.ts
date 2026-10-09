/**
 * useReviewCommandCompletion — keeps an open review's completion ("Applying",
 * "Discarding", "No changes left") in step with the draft command in
 * flight on its draft, whichever controller sent it.
 *
 * A command's identity, mode, coverage and the draft generation it acted on
 * live in the draft's claim, and the server's answer lands there
 * (`draft-command-record`), so the review needs nothing from the sender. A
 * review that opens on a claimed draft adopts the claim (`draftClaim`); one
 * already open follows it: pending when it begins, closed on the answer that
 * closed the draft (before any list read can drop the draft), and withdrawn
 * when the claim ends without that answer (a refusal, a lost request, a change
 * that did not close the draft). Every action carries the claim's generation;
 * the reducer applies it only to a review of that generation (rows C1-C5 of
 * `draft-review-session`), so the server's reused id, carrying a new proposal,
 * is never given an old proposal's completion.
 *
 * Every change to a claim of the Work is dispatched, whichever review is
 * rendered: the reducer applies it in order with the review's own transitions
 * (`enterInline`) and ignores it when it names another draft, so a draft
 * entered and answered in one flush still settles.
 */

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useEffect } from "react";
import {
  changedDrafts,
  currentDraftCommandRecords,
  type DraftCommandRecords,
  pendingChangeCommand,
  pendingDraftCommand,
  subscribeDraftCommandRecords,
} from "@/client/query/draft-command-record";
import type {
  DraftReviewAction,
  DraftReviewSelection,
  DraftReviewState,
  ReviewClaim,
} from "./draft-review-session";
import { listedDocumentName } from "./useSelectionCommands";

type Scope = { projectId: string; workId: string };

/**
 * The claim in flight on this draft as a review reads it: the generation it
 * acted on and the completion it gives, if any. The document's name is read
 * now, since the draft leaves the list once the answer's reads land.
 */
export function draftClaim(
  queryClient: QueryClient,
  draft: Scope & DraftReviewSelection,
  records: DraftCommandRecords = currentDraftCommandRecords(),
): ReviewClaim | undefined {
  const command = pendingDraftCommand(records, draft);
  if (!command || command.draftGeneration === undefined) return undefined;
  if (command.draftClosed)
    return {
      draftGeneration: command.draftGeneration,
      completion: { phase: "closed", documentName: command.draftClosed.documentName },
    };
  return {
    draftGeneration: command.draftGeneration,
    ...(command.completesDraft
      ? {
          completion: {
            phase: "pending" as const,
            mode: command.mode,
            documentName: listedDocumentName(
              queryClient,
              draft.projectId,
              draft.workId,
              draft.draftId,
            ),
          },
        }
      : {}),
  };
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
  queryClient: QueryClient,
): DraftReviewAction | null {
  const { documentId, draftId } = draft;
  const current = pendingDraftCommand(records, draft);
  const prior = pendingDraftCommand(previous, draft);
  const claim =
    current?.draftGeneration !== undefined
      ? { ...current, draftGeneration: current.draftGeneration }
      : null;
  const before =
    prior?.draftGeneration !== undefined
      ? { ...prior, draftGeneration: prior.draftGeneration }
      : null;
  if (claim?.draftClosed)
    return before?.draftClosed
      ? null
      : {
          type: "reviewClosed",
          documentId,
          draftId,
          draftGeneration: claim.draftGeneration,
          documentName: claim.draftClosed.documentName,
        };
  if (current === prior) return null;
  if (claim?.completesDraft)
    return {
      type: "reviewCompleting",
      documentId,
      draftId,
      draftGeneration: claim.draftGeneration,
      mode: claim.mode,
      documentName: listedDocumentName(queryClient, draft.projectId, draft.workId, draftId),
    };
  // Only a prediction is withdrawn (the reducer keeps what the server closed).
  return before?.completesDraft
    ? { type: "reviewReopened", documentId, draftId, draftGeneration: before.draftGeneration }
    : null;
}

export function useReviewCommandCompletion({
  projectId,
  workId,
  activeRef,
  stateRef,
  dispatch,
}: Scope & {
  activeRef: { readonly current: boolean };
  stateRef: { readonly current: DraftReviewState };
  dispatch: Dispatch<DraftReviewAction>;
}): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeDraftCommandRecords((records, previous) => {
        if (!activeRef.current) return;
        for (const draft of changedDrafts(records, previous, { projectId, workId })) {
          const action = completionAction(records, previous, draft, queryClient);
          if (action) dispatch(action);
          const command = pendingChangeCommand(records, draft);
          const before = pendingChangeCommand(previous, draft);
          const review = stateRef.current.surface;
          if (
            command?.outcome &&
            command.outcome !== before?.outcome &&
            review.kind === "inline" &&
            review.documentId === draft.documentId &&
            review.draftId === draft.draftId &&
            review.draftGeneration === command.draftGeneration
          )
            dispatch({
              type: "toast",
              code: command.outcome,
              tone: command.outcome === "change-gone" ? "error" : "info",
            });
        }
      }),
    [projectId, workId, queryClient, activeRef, stateRef, dispatch],
  );
}
