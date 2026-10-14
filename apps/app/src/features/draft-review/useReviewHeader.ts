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

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type DraftCommandFailure,
  draftCommandFailure,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { draftMetaQueryOptions } from "@/client/query/useDraftMeta";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { useDraftReview } from "./DraftReviewProvider";
import { nextReviewFile } from "./review-files";
import type { ReviewSurface } from "./review-runtime";
import { type HeadlessReview, type ReviewChangesView, useReviewChanges } from "./useReviewChanges";

export type ReviewHeaderOptions = {
  documentId: string;
  /** Empty while a stable chrome wrapper has no shown review. */
  itemKey: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /** Opens another draft of the Work in review (the presenting container's launcher). */
  onOpenDraft: (row: ReviewFileTarget) => void;
  /** The editor surface this header belongs to: its commands act in that surface's editor. */
  surface?: ReviewSurface;
  /** Set where the review has no editor (the phone): Discards are headless edits with their own Undo. */
  headless?: HeadlessReview;
};

export type ReviewHeaderModel = {
  controller: ReturnType<typeof useDraftReview>["controller"];
  view: ReviewChangesView;
  /** A draft-only document has no live version: its way out closes the tab. */
  draftOnly: boolean;
  /** Opens another draft of the Work in review (the presenting container's launcher). */
  openDraft: (row: ReviewFileTarget) => void;
  /** The next draft in the switcher, if the Work has one. */
  next: ReviewFileTarget | null;
  locked: boolean;
  /** Nothing left to publish: the server closed the draft, so its commands go. */
  finished: boolean;
  /** The last change's command is in flight: the review says so and is not finished. */
  completing: "apply" | "discard" | null;
  /** What the last whole-draft command of the open draft left on it (a refusal, a lost answer), if anything. */
  commandError: DraftCommandFailure | null;
  /** Live text the last Apply replaced because both sides changed the same words. */
  appliedOver: ReturnType<typeof useReviewFailures>["appliedOver"];
  dismissAppliedOver: () => void;
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
 * (`documentId`, `itemKey`) reads it: its own draft's failure, every listed
 * draft's (a draft the review moved on from still says it was refused), and
 * the other drafts' separately. Pure reads of the command records, so the
 * identity row's notices can read them beside the header model.
 */
export function useReviewFailures({
  documentId,
  itemKey,
}: {
  documentId: string;
  itemKey: string;
}) {
  const { controller, files } = useDraftReview();
  const commandRecords = useDraftCommandRecords();
  const draftOf = (row: { documentId: string; draft: { itemKey: string } }) => ({
    projectId: controller.projectId,
    workId: controller.workId,
    documentId: row.documentId,
    itemKey: row.draft.itemKey,
  });
  const commandError = draftCommandFailure(commandRecords, {
    projectId: controller.projectId,
    workId: controller.workId,
    documentId,
    itemKey,
  });
  const failedElsewhere: { row: ReviewFileTarget; failure: DraftCommandFailure }[] = [];
  for (const row of files) {
    const failure = draftCommandFailure(commandRecords, draftOf(row));
    if (!failure) continue;
    if (row.documentId !== documentId) failedElsewhere.push({ row, failure });
  }
  return {
    commandError,
    failedElsewhere,
    appliedOver: controller.appliedOver,
    dismissAppliedOver: controller.dismissAppliedOver,
  };
}

export function useReviewHeader({
  documentId,
  itemKey,
  onCloseDraftOnly,
  onOpenDraft,
  surface = "editor",
  headless,
}: ReviewHeaderOptions): ReviewHeaderModel {
  const { controller, files } = useDraftReview();
  const view = useReviewChanges(controller, {
    enabled: Boolean(itemKey),
    editor: surface,
    headless,
  });

  const next = nextReviewFile(files, documentId);
  // The draft Next draft moves to is looked up while the writer is still here, so opening it finds
  // where its room lives already in the cache.
  const queryClient = useQueryClient();
  const nextDocumentId = next?.documentId;
  const nextItemKey = next?.draft.itemKey;
  const ready = view.status === "ready";
  useEffect(() => {
    if (!ready || !nextDocumentId || !nextItemKey) return;
    void queryClient.prefetchQuery(
      draftMetaQueryOptions({
        projectId: controller.projectId,
        workId: controller.workId,
        documentId: nextDocumentId,
        itemKey: nextItemKey,
      }),
    );
  }, [ready, nextDocumentId, nextItemKey, controller.projectId, controller.workId, queryClient]);
  const locked = controller.dispositionLocked;
  const { finished, completing } = view;
  const { commandError, failedElsewhere, appliedOver, dismissAppliedOver } = useReviewFailures({
    documentId,
    itemKey,
  });
  const showLive = () => (onCloseDraftOnly ?? controller.exitInlineReview)();

  /**
   * Run a whole-draft command. The review stays on this draft, empty ("No changes left"): Discard draft is
   * an edit Ctrl+Z restores, and Apply leaves the draft open for the AI's next write. The writer moves on
   * with Next draft or Back to live.
   */
  const dispose = (mode: "apply" | "discard") => {
    if (locked) return;
    if (mode === "discard" && headless && !view.wholeDocument) {
      headless.discards.discardAll(headless.file, headless.roomName);
      return;
    }
    void controller.startDraft(
      mode,
      { documentId, itemKey },
      { frame: view.frame, editor: surface },
    ).outcome;
  };
  return {
    controller,
    view,
    next,
    locked,
    finished,
    completing,
    commandError,
    appliedOver,
    dismissAppliedOver,
    failedElsewhere,
    showLive,
    applyDraft: () => dispose("apply"),
    discardDraft: () => dispose("discard"),
    draftOnly: Boolean(onCloseDraftOnly),
    openDraft: onOpenDraft,
  };
}
