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
 * refusal, a lost request, a change that did not close the draft). A claim
 * speaks only for the draft generation it was sent against: while the draft's
 * preview shows another, the server's reused id carries a new proposal, and
 * the claim's pending or closing completion is not applied to it.
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
  type DraftCommandRecords,
  type PendingChangeCommand,
  pendingChangeCommand,
  subscribeDraftCommandRecords,
} from "@/client/query/draft-command-record";
import type {
  DraftReviewAction,
  DraftReviewSelection,
  ReviewCompletion,
} from "./draft-review-session";
import { cachedPreviewGeneration, listedDocumentName } from "./useSelectionCommands";

type Scope = { projectId: string; workId: string };

/** What a draft's cache says now, read when a completion is decided. */
export type DraftReads = {
  /** Read now: the draft leaves the list once the answer's reads land. */
  documentName: () => string | null;
  /** The generation of the draft's active preview, if it has one cached. */
  previewGeneration: () => string | null;
};

export function draftReads(
  queryClient: QueryClient,
  { projectId, workId, documentId, draftId }: Scope & DraftReviewSelection,
): DraftReads {
  return {
    documentName: () => listedDocumentName(queryClient, projectId, workId, draftId),
    previewGeneration: () =>
      cachedPreviewGeneration(queryClient, projectId, workId, documentId, draftId),
  };
}

/**
 * A claim's completion belongs to the draft generation it was sent against.
 * The server reuses a draft's id for its next proposal, and the preview can
 * show that proposal before the claim ends; an active preview of another
 * generation is that proposal, and the claim says nothing about it. A draft
 * with no active preview cached (gone, unlisted, not read yet) follows the claim.
 */
function claimOfShownGeneration(
  claim: PendingChangeCommand | null,
  reads: DraftReads,
): PendingChangeCommand | null {
  if (!claim) return null;
  const shown = reads.previewGeneration();
  return shown === null || shown === claim.draftRevisionToken ? claim : null;
}

/** The completion the command in flight on this draft gives a review that opens on it, if any. */
export function commandCompletion(
  records: DraftCommandRecords,
  draft: Scope & DraftReviewSelection,
  reads: DraftReads,
): ReviewCompletion | undefined {
  const command = claimOfShownGeneration(pendingChangeCommand(records, draft), reads);
  if (command?.draftClosed)
    return { phase: "closed", documentName: command.draftClosed.documentName };
  if (command?.completesDraft)
    return { phase: "pending", mode: command.mode, documentName: reads.documentName() };
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
  reads: DraftReads,
): DraftReviewAction | null {
  const { documentId, draftId } = draft;
  const claim = pendingChangeCommand(records, draft);
  const before = pendingChangeCommand(previous, draft);
  const command = claimOfShownGeneration(claim, reads);
  if (command?.draftClosed)
    return before?.draftClosed
      ? null
      : {
          type: "reviewClosed",
          documentId,
          draftId,
          documentName: command.draftClosed.documentName,
        };
  if (claim === before) return null;
  if (command?.completesDraft)
    return {
      type: "reviewCompleting",
      documentId,
      draftId,
      mode: command.mode,
      documentName: reads.documentName(),
    };
  // Only a prediction is withdrawn (the reducer keeps what the server closed).
  // A claim of another generation is withdrawn too: its prediction was this
  // review's, made before the preview moved on.
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
          const action = completionAction(records, previous, draft, draftReads(queryClient, draft));
          if (action) dispatch(action);
        }
      }),
    [projectId, workId, queryClient, activeRef, dispatch],
  );
}
