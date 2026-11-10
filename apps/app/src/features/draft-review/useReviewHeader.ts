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
import { useEffect, useRef, useSyncExternalStore } from "react";
import { draftMetadataQueryOptions } from "@/client/query/useDraftMetadata";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { showDocumentLive } from "@/features/project/tab-view-commands";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { useDraftReview } from "./DraftReviewProvider";
import type { BranchCommandFailure } from "./review-command-types";
import { nextReviewFile } from "./review-files";
import { type ReviewChangesView, useReviewChanges } from "./useReviewChanges";

export type ReviewHeaderOptions = {
  documentId: string;
  /** Empty while a stable chrome wrapper has no shown review. */
  itemKey: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /** Opens another draft of the Work in review (the presenting container's launcher). */
  onOpenDraft: (row: ReviewFileTarget) => void;
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
  canApply: boolean;
  /** Nothing left to apply: the server closed the draft, so its commands go. */
  finished: boolean;
  /** The draft is open but lists no change: formatting remains, handled by Apply draft or Discard draft. */

  /** The last change's command is in flight: the review says so and is not finished. */
  completing: "apply" | "discard" | null;
  /** What the last command on the open draft left on it (a refusal, a lost answer), when no change bar shows it. */
  commandError: BranchCommandFailure | null;
  /**
   * The Work's other listed drafts that hold a refusal or a lost answer: Apply
   * all moves on (or finishes) while its commands run, and a draft can be
   * refused after the writer left it, so the review the writer is in must still
   * say which drafts did not apply.
   */
  failedElsewhere: { row: ReviewFileTarget; failure: BranchCommandFailure }[];
  showLive: () => void;
  applyDraft: () => void;
  discardDraft: () => void;
};

/**
 * What the Work's drafts hold as refused or lost, as the review of
 * (`documentId`, `itemKey`) reads it: its own draft's failure, and the other
 * listed drafts' separately (a draft the review moved on from still says it was
 * refused). Pure reads of the command records, so the identity row's notices
 * can read them beside the header model.
 *
 * Each failure shows once. While the focused change's bar is on screen
 * (`ReviewChangeBar`: always on a phone, with the marks on a desktop) it
 * carries the open draft's failure, so `commandError` is only the fallback for
 * a review with no bar showing.
 */
export function useReviewFailures(input: {
  documentId: string;
  itemKey: string;
  view: ReviewChangesView;
}) {
  const owner = useDraftCommandOwner();
  const { controller, files } = useDraftReview();
  const phone = usePhoneShell();
  const snapshot = () => (input.itemKey ? owner.snapshot() : 0);
  useSyncExternalStore(owner.subscribe, snapshot, snapshot);
  const { view } = input;
  const barCarries =
    view.itemKey === input.itemKey &&
    view.status === "ready" &&
    Boolean(view.focused) &&
    (phone || controller.marksVisible);
  return {
    commandError: barCarries ? null : owner.state(input.itemKey).failure,
    failedElsewhere: files.flatMap((row) => {
      const failure = owner.state(row.draft.itemKey).failure;
      return row.draft.itemKey !== input.itemKey && failure ? [{ row, failure }] : [];
    }),
  };
}

export function useReviewHeader({
  documentId,
  itemKey,
  onCloseDraftOnly,
  onOpenDraft,
}: ReviewHeaderOptions): ReviewHeaderModel {
  const { controller, files, drafts } = useDraftReview();
  const view = useReviewChanges(controller, { enabled: Boolean(itemKey) });

  // Only a file with text has a review to move to: a move or delete alone has no draft room.
  const next = nextReviewFile(
    files.filter((file) => file.draft.hasDraft || file.documentId === documentId),
    documentId,
    null,
  );
  // Warm the next addressed room lookup without fetching a server text preview.
  const queryClient = useQueryClient();
  const nextDocumentId = next?.documentId;
  const nextItemKey = next?.draft.itemKey;
  const ready = view.status === "ready";
  useEffect(() => {
    if (!ready || !nextDocumentId || !nextItemKey) return;
    void queryClient.prefetchQuery(
      draftMetadataQueryOptions({
        projectId: controller.projectId,
        ownerKey: controller.ownerKey,
        documentId: nextDocumentId,
        itemKey: nextItemKey,
      }),
    );
  }, [ready, nextDocumentId, nextItemKey, controller.projectId, controller.ownerKey, queryClient]);
  const locked = controller.dispositionLocked || view.status !== "ready";
  const { finished, completing } = view;
  const { commandError, failedElsewhere } = useReviewFailures({ documentId, itemKey, view });
  const showLive = () =>
    (onCloseDraftOnly ?? (() => showDocumentLive(controller.projectId, documentId)))();

  // The item this header shows while it is mounted; null once the writer has left it.
  const shown = useRef<string | null>(itemKey);
  useEffect(() => {
    shown.current = itemKey;
    return () => {
      shown.current = null;
    };
  }, [itemKey]);
  // Local Discard stays in this draft. Only an Apply that landed advances to another file: a
  // refusal shows on the draft the writer applied, so it must not move them first.
  const dispose = (mode: "apply" | "discard") => {
    if (locked) return;
    const start = controller.startDraft(mode, { documentId, itemKey });
    if (mode !== "apply" || !next || !start.sent) return;
    void start.outcome.then((outcome) => {
      if (outcome.kind === "done" && shown.current === itemKey) onOpenDraft(next);
    });
  };
  return {
    controller,
    view,
    next,
    locked,
    // A trashed chat's drafts take no Apply; its notice says how to bring it back.
    canApply: ready && view.items.length > 0 && !drafts.frozen,
    finished,
    completing,
    commandError,
    failedElsewhere,
    showLive,
    applyDraft: () => dispose("apply"),
    discardDraft: () => dispose("discard"),
    draftOnly: Boolean(onCloseDraftOnly),
    openDraft: onOpenDraft,
  };
}
