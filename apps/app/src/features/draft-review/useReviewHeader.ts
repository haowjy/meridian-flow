/**
 * useReviewHeader — everything a review header needs that is not layout: the
 * Work's drafts for the switcher (with their change counts), the open review's
 * changes, and the whole-draft commands that move on to the next draft.
 *
 * The desktop header and the phone header are two layouts over this one model,
 * so Apply draft, Discard draft, Apply all, "No changes left" and the refusal
 * line cannot drift between them.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  type DraftCommandFailureCode,
  draftCommandFailure,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, dockRows, draftAfter } from "@/features/chat/docked-drafts";
import type { DraftSwitcherProps } from "./DraftSwitcher";
import { useDraftChangeCounts } from "./useDraftChangeCounts";
import { type ReviewChangesView, useReviewChanges } from "./useReviewChanges";

export type ReviewHeaderOptions = {
  documentId: string;
  draftId: string;
  /** Set for a draft-only document: closes its tab instead of returning to live. */
  onCloseDraftOnly?: () => void;
  /** Opens another draft of the Work in review (the editor's launcher). */
  onOpenDraft: (row: DockRow) => void;
};

export type ReviewHeaderModel = {
  controller: ReturnType<typeof useDraftReview>["controller"];
  view: ReviewChangesView;
  /** What `DraftSwitcher` is given, minus the layout-specific props. */
  switcher: Omit<DraftSwitcherProps, "touch">;
  /** The next draft in the switcher, if the Work has one. */
  next: DockRow | null;
  locked: boolean;
  /** Nothing left to publish: the server closed the draft, so its commands go. */
  finished: boolean;
  /** The draft is open but lists no change: formatting remains, handled by Apply draft or Discard draft. */
  unlisted: boolean;
  /** The last change's command is in flight: the review says so and is not finished. */
  completing: "apply" | "discard" | null;
  /** What the last whole-draft command of the open draft left on it (a refusal, a lost answer), if anything. */
  commandError: DraftCommandFailureCode | null;
  /**
   * The Work's other listed drafts that hold a refusal or a lost answer: Apply
   * draft and Apply all move on (or finish) while the command runs, so the
   * review the writer is in must still say which drafts did not apply.
   */
  failedElsewhere: { row: DockRow; code: DraftCommandFailureCode }[];
  showLive: () => void;
  applyDraft: () => void;
  discardDraft: () => void;
};

export function useReviewHeader({
  documentId,
  draftId,
  onCloseDraftOnly,
  onOpenDraft,
}: ReviewHeaderOptions): ReviewHeaderModel {
  const { controller, groups } = useDraftReview();
  const view = useReviewChanges(controller);
  const rows = useMemo(() => dockRows(groups), [groups]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const counts = useDraftChangeCounts(
    controller,
    rows
      .filter((row) => row.documentId !== documentId)
      .map((row) => ({ documentId: row.documentId, draftId: row.draft.draftId })),
    switcherOpen,
  );
  const allCounts = useMemo(() => {
    const merged = new Map(counts);
    if (view.status === "ready") merged.set(documentId, view.items.length);
    return merged;
  }, [counts, documentId, view.items.length, view.status]);

  const next = draftAfter(rows, documentId);
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
  // Every listed draft that holds one, so a draft the review moved on from still says it was refused.
  const failures = new Map<string, DraftCommandFailureCode>();
  const failedElsewhere: ReviewHeaderModel["failedElsewhere"] = [];
  for (const row of rows) {
    const code = draftCommandFailure(commandRecords, draftOf(row));
    if (!code) continue;
    failures.set(row.documentId, code);
    if (row.documentId !== documentId) failedElsewhere.push({ row, code });
  }
  const showLive = () => (onCloseDraftOnly ?? controller.exitInlineReview)();

  /** Run a whole-draft command, then move to the next draft (or live) without waiting on it. */
  const dispose = (command: () => Promise<unknown>) => {
    if (locked) return;
    void command();
    if (next) onOpenDraft(next);
  };
  const selections = rows.map((row) => ({
    documentId: row.documentId,
    draftId: row.draft.draftId,
  }));

  /**
   * Apply all or Discard all. The batch never stops at a refusal, and nothing in
   * it moves the writer: the drafts are independent, an answer can come back
   * long after the writer went elsewhere, and a refusal is held on its own draft
   * (listed wherever drafts are, with Open as the way to it). The draft the
   * writer is in holds on "No changes left" when the batch closes it.
   */
  const disposeAll = (mode: "apply" | "discard") => {
    void controller.disposeDrafts(mode, selections);
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
    switcher: {
      rows,
      currentDocumentId: documentId,
      currentName: controller.inlineReview?.completion?.documentName ?? null,
      counts: allCounts,
      failures,
      onOpenChange: setSwitcherOpen,
      draftOnly: Boolean(onCloseDraftOnly),
      disabled: locked,
      onOpenDraft,
      onShowLive: showLive,
      onApplyAll: () => disposeAll("apply"),
      onDiscardAll: () => disposeAll("discard"),
    },
  };
}
