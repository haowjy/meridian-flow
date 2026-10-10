/**
 * useDraftChanges — the change list of any one draft of a Work: its preview
 * (read through `useDraftPreviews`, so a failed read is `error`, not "no
 * changes", and the list refreshes with the draft's list row), its changes with
 * what failed on each, and Apply and Discard of one change.
 *
 * No focus, no stepping, no completion, and it never joins a review room.
 * Commands are bound to the caller’s Work. For the open draft the view is the
 * Editor's own (`useReviewChanges`), so the rows agree with the manuscript's
 * marks.
 */
import { useCallback, useMemo } from "react";

import { useDraftPreviews } from "@/client/query/useDraftPreview";
import { selectionOf } from "./change-selection";
import { useEditorDraftReview } from "./DraftReviewProvider";
import {
  type DraftChangesView,
  listablePreview,
  type ReviewChangeItem,
  useChangeItems,
} from "./draft-changes";
import type { ReviewChange } from "./review-changes";
import { reviewChangesOfPreview } from "./review-changes";
import { useReviewChanges } from "./useReviewChanges";
import type { WorkDraftCommands } from "./useWorkDraftCommands";

export type DraftChangesTarget = {
  projectId: string;
  workId: string;
  documentId: string;
  draftId: string;
};

const NO_CHANGES: readonly ReviewChange[] = [];
const NO_ITEMS: readonly ReviewChangeItem[] = [];

export function useDraftChanges(
  target: DraftChangesTarget,
  options: {
    /** The caller's own scope: runs the commands of a draft the Editor does not have open. */
    controller: Pick<WorkDraftCommands, "applyChanges" | "discardChanges" | "dispositionLocked">;
    enabled?: boolean;
  },
): DraftChangesView {
  const { controller, enabled = true } = options;
  const editor = useEditorDraftReview().controller;
  const runner = controller;
  const open = editor.inlineReview;
  const inEditor =
    enabled &&
    editor.projectId === target.projectId &&
    editor.workId === target.workId &&
    open?.documentId === target.documentId &&
    open.draftId === target.draftId;
  const editorView = useReviewChanges(editor, { enabled: inEditor });

  const { projectId, workId, documentId, draftId } = target;
  const draft = useMemo(
    () => ({ projectId, workId, documentId, draftId }),
    [projectId, workId, documentId, draftId],
  );
  const entry = useDraftPreviews(enabled && !inEditor ? [draft] : [], { openReview: open })[0];
  const active = entry?.status === "ready" ? listablePreview(entry.preview) : null;
  const changes = active ? reviewChangesOfPreview(active) : NO_CHANGES;
  const { items, hiding } = useChangeItems(draft, changes);

  const apply = useCallback(
    async (change: ReviewChange) => {
      if (change.actionable) await runner.applyChanges(draft, selectionOf([change]));
    },
    [draft, runner.applyChanges],
  );
  const discard = useCallback(
    async (change: ReviewChange) => {
      if (change.actionable) await runner.discardChanges(draft, selectionOf([change]));
    },
    [draft, runner.discardChanges],
  );

  const status: DraftChangesView["status"] = !entry
    ? "idle"
    : entry.status === "error"
      ? "error"
      : active
        ? "ready"
        : entry.status === "ready" && entry.preview.status === "gone"
          ? "gone"
          : "loading";

  const own = useMemo<DraftChangesView>(
    () => ({
      documentId,
      draftId,
      status,
      items: status === "ready" ? items : NO_ITEMS,
      focused: null,
      canApply: active?.isNewDocument !== true,
      locked: controller.dispositionLocked,
      unlisted: status === "ready" && items.length === 0 && !hiding,
      ...(entry?.status === "error" ? { retry: entry.retry } : {}),
      apply,
      discard,
    }),
    [
      documentId,
      draftId,
      status,
      items,
      active?.isNewDocument,
      controller.dispositionLocked,
      hiding,
      entry,
      apply,
      discard,
    ],
  );
  // Reuse the open review's presentation, never its command authority.
  return inEditor ? { ...editorView, apply, discard, locked: controller.dispositionLocked } : own;
}
