/**
 * useReviewCommandCompletion — keeps an open review's completion ("Applying",
 * "Discarding", "No changes left") in step with the draft command in
 * flight on its draft, whichever controller sent it.
 *
 * A command's identity, mode, coverage and the draft generation it acted on
 * live in the draft's claim, and the server's answer lands there
 * (`branch-command-record`), so the review needs nothing from the sender. A
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
import { listedDocumentName } from "@/client/query/branch-command-executor";
import {
  type BranchCommandRecords,
  changedDrafts,
  currentBranchCommandRecords,
  pendingBranchCommand,
  pendingChangeCommand,
  subscribeBranchCommandRecords,
} from "@/client/query/branch-command-record";
import type {
  DraftReviewAction,
  DraftReviewSelection,
  DraftReviewState,
  ReviewClaim,
} from "./draft-review-session";

type Scope = { projectId: string; workId: string };

/**
 * The claim in flight on this draft as a review reads it: the generation it
 * acted on and the completion it gives, if any. The document's name is read
 * now, since the draft leaves the list once the answer's reads land.
 */
export function draftClaim(
  queryClient: QueryClient,
  draft: Scope & DraftReviewSelection,
  records: BranchCommandRecords = currentBranchCommandRecords(),
): ReviewClaim | undefined {
  const command = pendingBranchCommand(records, draft);
  if (!command || command.draftGeneration === undefined) return undefined;
  if (command.itemClosed)
    return {
      draftGeneration: command.draftGeneration,
      completion: { phase: "closed", documentName: command.itemClosed.documentName },
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
              draft.itemKey,
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
  records: BranchCommandRecords,
  previous: BranchCommandRecords,
  draft: Scope & DraftReviewSelection,
  queryClient: QueryClient,
): DraftReviewAction | null {
  const current = pendingBranchCommand(records, draft);
  const prior = pendingBranchCommand(previous, draft);
  const claim = draftClaim(queryClient, draft, records);
  const before = draftClaim(queryClient, draft, previous);
  if (claim?.completion?.phase === "closed") {
    if (before?.completion?.phase === "closed") return null;
  } else {
    if (current === prior) return null;
    if (!claim?.completion && (!prior?.completesDraft || !before)) return null;
  }
  const generation = claim?.completion ? claim.draftGeneration : before?.draftGeneration;
  if (generation === undefined) return null;
  return {
    type: "completionObserved",
    documentId: draft.documentId,
    itemKey: draft.itemKey,
    draftGeneration: generation,
    completion: claim?.completion ?? null,
  };
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
      subscribeBranchCommandRecords((records, previous) => {
        if (!activeRef.current) return;
        for (const draft of changedDrafts(records, previous, { projectId, workId })) {
          const action = completionAction(records, previous, draft, queryClient);
          if (action) dispatch(action);
          const command = pendingChangeCommand(records, draft);
          const before = pendingChangeCommand(previous, draft);
          const review = stateRef.current.surface;
          if (
            command?.outcome === "change-gone" &&
            command.outcome !== before?.outcome &&
            review.kind === "inline" &&
            review.documentId === draft.documentId &&
            review.itemKey === draft.itemKey &&
            review.draftGeneration === command.draftGeneration
          )
            dispatch({
              type: "toast",
              code: command.outcome,
              tone: "error",
            });
        }
      }),
    [projectId, workId, queryClient, activeRef, stateRef, dispatch],
  );
}
