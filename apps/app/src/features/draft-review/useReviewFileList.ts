/**
 * useReviewFileList — the Work's draft files as `ReviewFiles` takes them: every
 * file once, in the one file order, the file under review marked open, with the
 * Work-wide Apply all and Discard all. The dock's Changes tab and the phone's
 * changes sheet are two layouts over it, so they cannot order or label files
 * differently.
 */
import { t } from "@lingui/core/macro";
import { createElement, useMemo } from "react";

import {
  clearDraftCommandFailure,
  draftCommandFailure,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { type DockRow, dockRowName, dockRows, sortDraftFiles } from "@/features/chat/docked-drafts";
import { DraftStatsLabel, draftStats } from "@/features/chat/draft-stats";
import type { DraftReviewController } from "@/features/chat/useDraftReviewController";
import type { ReviewFile, ReviewFilesBatch } from "./ReviewFiles";
import type { ReviewChangesView } from "./useReviewChanges";

type Scope = {
  controller: Pick<
    DraftReviewController,
    "projectId" | "workId" | "inlineReview" | "dispositionLocked" | "disposeDrafts"
  >;
  groups: ThreadDraftGroup[] | null | undefined;
};

/** A draft file in the list: a listed draft, or the open review whose draft has left the list. */
type ListedFile = {
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  workId: string;
  row: DockRow | null;
};

export function useReviewFileList({
  review,
  view,
  openDraft,
  other,
}: {
  /** The Work the review lives in: its drafts, its Apply all and Discard all. */
  review: Scope;
  view: ReviewChangesView;
  openDraft: (row: DockRow, workId: string) => void;
  /** Another Work's drafts listed beside it (the chat can be in another Work than the Editor). */
  other?: Scope;
}): { files: ReviewFile[]; rows: DockRow[]; batch: ReviewFilesBatch } {
  const { controller } = review;
  const commandRecords = useDraftCommandRecords();
  const rows = useMemo(() => dockRows(review.groups), [review.groups]);
  const otherRows = useMemo(
    () => (other && other.controller.workId !== controller.workId ? dockRows(other.groups) : []),
    [other, controller.workId],
  );
  const reviewed = controller.inlineReview;
  const reviewedDocumentId = reviewed?.documentId ?? null;
  const closedName = reviewed?.completion?.documentName ?? null;

  const listed = useMemo(() => {
    const files: ListedFile[] = [
      ...rows.map((row) => ({ ...row, workId: controller.workId, row })),
      ...otherRows.map((row) => ({ ...row, workId: other?.controller.workId ?? "", row })),
    ];
    // A finished review's draft has left the list; it keeps its place by name until the writer moves on.
    if (reviewedDocumentId && !rows.some((row) => row.documentId === reviewedDocumentId)) {
      files.push({
        documentId: reviewedDocumentId,
        documentName: closedName,
        contextPath: null,
        workId: controller.workId,
        row: null,
      });
    }
    return sortDraftFiles(files);
  }, [rows, otherRows, other, controller.workId, reviewedDocumentId, closedName]);

  const count = view.items.length;
  const showCount = view.status === "ready" && !view.finished && !view.completing && !view.unlisted;
  const files = listed.map<ReviewFile>((file) => {
    const open = file.workId === controller.workId && file.documentId === reviewedDocumentId;
    const draftRef = file.row
      ? {
          projectId: controller.projectId,
          workId: file.workId,
          documentId: file.documentId,
          draftId: file.row.draft.draftId,
        }
      : null;
    const stats = file.row ? draftStats(file.row.draft) : null;
    return {
      key: `${file.workId}:${file.documentId}`,
      name: file.row
        ? dockRowName(file.row, t`Untitled document`)
        : (file.documentName ?? t`This draft`),
      open,
      isNewDocument: file.row?.isNewDocument === true,
      meta: open
        ? showCount
          ? count === 1
            ? t`1 change`
            : t`${count} changes`
          : null
        : stats
          ? createElement(DraftStatsLabel, { stats, wordsSuffix: false })
          : null,
      error: draftRef ? draftCommandFailure(commandRecords, draftRef) : null,
      onOpen: () => file.row && openDraft(file.row, file.workId),
      onDismissError: () => draftRef && clearDraftCommandFailure(draftRef),
    };
  });

  const selections = rows.map((row) => ({
    documentId: row.documentId,
    draftId: row.draft.draftId,
  }));
  return {
    files,
    rows,
    batch: {
      count: rows.length,
      disabled: controller.dispositionLocked,
      onApplyAll: () => void controller.disposeDrafts("apply", selections),
      onDiscardAll: () => void controller.disposeDrafts("discard", selections),
    },
  };
}
