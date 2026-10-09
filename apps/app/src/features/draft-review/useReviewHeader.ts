/**
 * useReviewHeader — everything a review header needs that is not layout: the
 * open review's changes, the next draft file, and the whole-draft commands that
 * move on to it.
 *
 * The identity row's controls and the phone header are two layouts over this one
 * model, so Apply draft, Discard draft, "No changes left" and the refusal line
 * cannot drift between them. Work-wide Apply all and Discard all belong to the
 * Work page's Changes to review (`WorkChanges`), not here.
 */

import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type DraftCommandFailure,
  draftCommandFailure,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { useDraftReview } from "./DraftReviewProvider";
import { nextReviewFile } from "./review-files";
import { type ReviewChangesView, useReviewChanges } from "./useReviewChanges";

export type ReviewHeaderOptions = {
  documentId: string;
  draftId: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /** Opens another draft of the Work in review (the editor's launcher). */
  onOpenDraft: (row: ReviewFileTarget) => void;
};

export type ReviewHeaderModel = {
  controller: ReturnType<typeof useDraftReview>["controller"];
  view: ReviewChangesView;
  /** A draft-only document has no live version: its way out closes the tab. */
  draftOnly: boolean;
  /** Opens another draft of the Work in review (the editor's launcher). */
  openDraft: (row: ReviewFileTarget) => void;
  /** The next draft in the switcher, if the Work has one. */
  next: ReviewFileTarget | null;
  locked: boolean;
  /** Nothing left to publish: the server closed the draft, so its commands go. */
  finished: boolean;
  /** The draft is open but lists no change: formatting remains, handled by Apply draft or Discard draft. */
  unlisted: boolean;
  /** The last change's command is in flight: the review says so and is not finished. */
  completing: "apply" | "discard" | null;
  /** What the last whole-draft command of the open draft left on it (a refusal, a lost answer), if anything. */
  commandError: DraftCommandFailure | null;
  /**
   * The Work's other listed drafts that hold a refusal or a lost answer: Apply
   * draft and Apply all move on (or finish) while the command runs, so the
   * review the writer is in must still say which drafts did not apply.
   */
  failedElsewhere: { row: ReviewFileTarget; failure: DraftCommandFailure }[];
  showLive: () => void;
  applyDraft: () => void;
  discardDraft: () => void;
};

/**
 * What the Work's drafts hold as refused or lost, as the review of
 * (`documentId`, `draftId`) reads it: its own draft's failure, every listed
 * draft's (a draft the review moved on from still says it was refused), and
 * the other drafts' separately. Pure reads of the command records, so the
 * identity row's notices can read them beside the header model.
 */
export function useReviewFailures({
  documentId,
  draftId,
}: {
  documentId: string;
  draftId: string;
}) {
  const { controller, files } = useDraftReview();
  const commandRecords = useDraftCommandRecords();
  const draftOf = (row: { documentId: string; draft: { draftId: string } }) => ({
    projectId: controller.projectId,
    workId: controller.workId,
    documentId: row.documentId,
    draftId: row.draft.draftId,
  });
  const commandError = draftCommandFailure(commandRecords, {
    projectId: controller.projectId,
    workId: controller.workId,
    documentId,
    draftId,
  });
  const failedElsewhere: { row: ReviewFileTarget; failure: DraftCommandFailure }[] = [];
  for (const row of files) {
    const failure = draftCommandFailure(commandRecords, draftOf(row));
    if (!failure) continue;
    if (row.documentId !== documentId) failedElsewhere.push({ row, failure });
  }
  return { commandError, failedElsewhere };
}

export function useReviewHeader({
  documentId,
  draftId,
  onCloseDraftOnly,
  onOpenDraft,
}: ReviewHeaderOptions): ReviewHeaderModel {
  const { controller, files } = useDraftReview();
  const view = useReviewChanges(controller);

  const next = nextReviewFile(
    files,
    documentId,
    controller.inlineReview?.completion?.documentName ?? null,
  );
  // The draft Apply draft, Discard draft and Next draft move to is read while
  // the writer is still here (once this review's own read is in), so opening it
  // finds its preview already in the cache.
  const queryClient = useQueryClient();
  const nextDocumentId = next?.documentId;
  const nextDraftId = next?.draft.draftId;
  const ready = view.status === "ready";
  useEffect(() => {
    if (!ready || !nextDocumentId || !nextDraftId) return;
    void queryClient.prefetchQuery(
      draftPreviewQueryOptions({
        projectId: controller.projectId,
        workId: controller.workId,
        documentId: nextDocumentId,
        draftId: nextDraftId,
      }),
    );
  }, [ready, nextDocumentId, nextDraftId, controller.projectId, controller.workId, queryClient]);
  const locked = controller.dispositionLocked;
  const { finished, completing, unlisted } = view;
  const { commandError, failedElsewhere } = useReviewFailures({ documentId, draftId });
  const showLive = () => (onCloseDraftOnly ?? controller.exitInlineReview)();

  /**
   * Run a whole-draft command, then move to the next draft (or live) without
   * waiting on it. Offline the command is refused before it is sent, so the
   * writer stays on this draft, where the refusal shows.
   */
  const dispose = (command: () => Promise<unknown>) => {
    if (locked) return;
    const sending = onlineManager.isOnline();
    void command();
    if (next && sending) onOpenDraft(next);
  };
  return {
    controller,
    view,
    next,
    locked,
    finished,
    unlisted,
    completing,
    commandError,
    failedElsewhere,
    showLive,
    applyDraft: () => dispose(() => controller.apply(documentId, draftId)),
    discardDraft: () => dispose(() => controller.discard(documentId, draftId)),
    draftOnly: Boolean(onCloseDraftOnly),
    openDraft: onOpenDraft,
  };
}
