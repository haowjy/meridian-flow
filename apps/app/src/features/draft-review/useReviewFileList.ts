/**
 * useReviewFileList — one Work's draft files as `ReviewFiles` takes them: every
 * file once, in the one file order, the file under review marked open, with the
 * Work's Apply all and Discard all. The dock's Changes tab and the phone's
 * changes sheet are two layouts over it, so they cannot order or label files
 * differently.
 *
 * One list is one Work: its rows are what its Apply all and Discard all act on,
 * and its count is of those rows. A review whose draft has left the list keeps
 * its place by name, shown but not counted.
 *
 * Stable actions, volatile view (as in `ContextTreeRows`): the files are built
 * from the Work's rows and records and the open file's change count only, so a
 * focus change, which moves `view` and nothing else, hands `ReviewFiles` the
 * same file objects and no closed row renders again.
 */
import { useMemo, useRef } from "react";

import {
  clearDraftCommandFailure,
  draftCommandFailure,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { draftStats } from "./draft-stats";
import type { ReviewFile, ReviewFilesBatch } from "./ReviewFiles";
import {
  type ReviewFileTarget,
  reviewFileTargetName,
  reviewFileTargets,
  sortDraftFiles,
} from "./review-files";
import type { DraftReviewController } from "./useDraftReviewController";
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
  row: ReviewFileTarget | null;
};

export function useReviewFileList({
  review,
  view,
  openDraft,
}: {
  /** The Work whose drafts these are: its review, its Apply all and Discard all. */
  review: Scope;
  /** The review's changes, for the open file's count; null for a Work with no review open. */
  view: ReviewChangesView | null;
  openDraft: (row: ReviewFileTarget, workId: string) => void;
}): { files: ReviewFile[]; rows: ReviewFileTarget[]; batch: ReviewFilesBatch } {
  const { controller } = review;
  const { projectId, workId, disposeDrafts, dispositionLocked } = controller;
  const commandRecords = useDraftCommandRecords();
  const rows = useMemo(() => reviewFileTargets(review.groups), [review.groups]);
  const reviewedDocumentId = controller.inlineReview?.documentId ?? null;
  const closedName = controller.inlineReview?.completion?.documentName ?? null;

  const listed = useMemo(() => {
    const files: ListedFile[] = rows.map((row) => ({ ...row, row }));
    // A finished review's draft has left the list; it keeps its place by name until the writer moves on.
    if (reviewedDocumentId && !rows.some((row) => row.documentId === reviewedDocumentId)) {
      files.push({
        documentId: reviewedDocumentId,
        documentName: closedName,
        contextPath: null,
        row: null,
      });
    }
    return sortDraftFiles(files);
  }, [rows, reviewedDocumentId, closedName]);

  // The latest opener without making every file depend on it.
  const openDraftRef = useRef(openDraft);
  openDraftRef.current = openDraft;

  const base = useMemo(
    () =>
      listed.map<ReviewFile>((file) => {
        const draftRef = file.row
          ? { projectId, workId, documentId: file.documentId, draftId: file.row.draft.draftId }
          : null;
        return {
          key: `${workId}:${file.documentId}`,
          // Unnamed is null, not a phrase: the words are chosen when shown, in the language shown.
          name: (file.row ? reviewFileTargetName(file.row, "") : file.documentName) || null,
          held: file.row === null,
          open: file.documentId === reviewedDocumentId,
          isNewDocument: file.row?.isNewDocument === true,
          changeCount: null,
          stats: file.row ? draftStats(file.row.draft) : null,
          error: draftRef ? draftCommandFailure(commandRecords, draftRef) : null,
          onOpen: () => file.row && openDraftRef.current(file.row, workId),
          onDismissError: () => draftRef && clearDraftCommandFailure(draftRef),
        };
      }),
    [listed, commandRecords, projectId, workId, reviewedDocumentId],
  );

  // Only the open file knows how many changes it has; the rest keep their identity.
  const openChangeCount =
    view && view.status === "ready" && !view.finished && !view.completing && !view.unlisted
      ? view.items.length
      : null;
  const files = useMemo(
    () =>
      openChangeCount === null
        ? base
        : base.map((file) => (file.open ? { ...file, changeCount: openChangeCount } : file)),
    [base, openChangeCount],
  );

  const batch = useMemo<ReviewFilesBatch>(() => {
    const selections = rows.map((row) => ({
      documentId: row.documentId,
      draftId: row.draft.draftId,
    }));
    return {
      count: rows.length,
      disabled: dispositionLocked,
      onApplyAll: () => void disposeDrafts("apply", selections),
      onDiscardAll: () => void disposeDrafts("discard", selections),
    };
  }, [rows, dispositionLocked, disposeDrafts]);

  return { files, rows, batch };
}
