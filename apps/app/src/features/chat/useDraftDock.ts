/**
 * useDraftDock — the composer strip's model: this chat's pending changes in its
 * Work, and the commands that act on them.
 *
 * Candidates come from the draft list (`actorThreads` names the chats with
 * pending writes in a draft); each candidate's preview confirms whether the
 * chat still has a change in it. Apply and Discard never touch a whole draft:
 * per file they name every operation of this chat's actionable changes, with
 * that preview's tokens, through the one selection-command transport (so a draft
 * open in the Editor is run by the Editor's controller). A refusal stays on its
 * file; nothing navigates.
 */
import { t } from "@lingui/core/macro";
import { useCallback, useMemo } from "react";
import {
  type ChangeCommandState,
  changeCommandState,
  type DraftCommandFailure,
  draftCommandFailure,
  useChangeCommandRecords,
} from "@/client/query/draft-command-record";
import { useDraftPreviews } from "@/client/query/useDraftPreview";
import { selectionOf } from "@/features/draft-review/change-selection";
import { useDraftReview, useEditorDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { reviewFileTargetName, reviewFileTargets } from "@/features/draft-review/review-files";
import { useChangeCommandRunner } from "@/features/draft-review/useChangeCommandRunner";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { type DockFile, dockFile, dockNotes, isOnStrip, totalChanges } from "./draft-dock-files";

export type DraftDockModel = ReturnType<typeof useDraftDock>;

/** What went wrong on a file: the strip's own command, else anything held on the draft (a failed Review launch). */
export type DockFileFailure =
  | { kind: "changes"; failure: Extract<ChangeCommandState, { phase: "failed" }> }
  | { kind: "draft"; failure: DraftCommandFailure };

export function useDraftDock({ threadId, generating }: { threadId: string; generating: boolean }) {
  const { groups, controller } = useDraftReview();
  const editor = useEditorDraftReview().controller;
  const { openAiDraft } = useAiDraftLauncher();
  const runner = useChangeCommandRunner(controller);
  const records = useChangeCommandRecords();
  const { projectId, workId } = controller;

  const candidates = useMemo(
    () =>
      reviewFileTargets(groups).filter((row) =>
        row.draft.actorThreads.some((chat) => chat.threadId === threadId),
      ),
    [groups, threadId],
  );
  const targets = useMemo(
    () =>
      candidates.map((row) => ({
        projectId,
        workId,
        documentId: row.documentId,
        draftId: row.draft.draftId,
      })),
    [candidates, projectId, workId],
  );
  // The open review keeps its own refresh; the strip refreshes the rest.
  const open = editor.workId === workId ? editor.inlineReview : null;
  const entries = useDraftPreviews(targets, { openReview: open });

  const untitled = t`Document`;
  const files = useMemo(
    () =>
      candidates
        .map((row, index) =>
          dockFile(row, reviewFileTargetName(row, untitled), entries[index], threadId),
        )
        .filter(isOnStrip),
    [candidates, entries, threadId, untitled],
  );
  const notes = useMemo(() => dockNotes(files), [files]);
  const actionableFiles = files.filter((file) => file.actionable.length > 0);

  const review = useCallback(
    (file: DockFile) => {
      const { row } = file;
      if (!row.contextPath) return;
      const focus = file.changes[0]?.operationIds;
      openAiDraft({
        workId,
        documentId: row.documentId,
        draftId: row.draft.draftId,
        contextPath: row.contextPath,
        documentName: row.documentName ?? undefined,
        isNewDocument: row.isNewDocument,
        ...(focus ? { focusOperationIds: focus } : {}),
      });
    },
    [openAiDraft, workId],
  );
  const reviewable = files.find((file) => file.row.contextPath) ?? null;

  const send = useCallback(
    (mode: "apply" | "discard") => {
      const items = actionableFiles.map((file) => ({
        draft: { documentId: file.row.documentId, draftId: file.row.draft.draftId },
        selection: selectionOf(file.actionable),
      }));
      if (items.length === 0) return;
      // The runner hides every file's selection at the click and returns each as
      // its own command answers; the records carry the outcomes.
      const batch = mode === "apply" ? runner.applyBatch(items) : runner.discardBatch(items);
      void batch.catch(() => {});
    },
    [actionableFiles, runner],
  );

  const fileFailure = (file: DockFile): DockFileFailure | null => {
    const ref = {
      projectId,
      workId,
      documentId: file.row.documentId,
      draftId: file.row.draft.draftId,
    };
    const state = changeCommandState(records, ref, selectionOf(file.changes));
    if (state?.phase === "failed") return { kind: "changes", failure: state };
    const held = draftCommandFailure(records.drafts, ref);
    return held ? { kind: "draft", failure: held } : null;
  };

  return {
    generating,
    files,
    mounted: files.length > 0,
    notes,
    changeCount: totalChanges(files),
    /**
     * Apply and Discard are offered while something can still be actionable: a
     * change they take, or an unread preview of a file the list does not already
     * call a new document (that file never joins them, so waiting on it would
     * paint the commands only to remove them).
     */
    showCommands:
      actionableFiles.length > 0 ||
      files.some((file) => file.status !== "ready" && !file.newDocument),
    canCommand: actionableFiles.length > 0 && !generating && !controller.dispositionLocked,
    /** Review is held while a whole-draft command is running in this Work. */
    reviewBusy: controller.isDisposing,
    reviewable: reviewable !== null,
    projectId,
    workId,
    fileFailure,
    review,
    reviewFirst: () => reviewable && review(reviewable),
    apply: () => send("apply"),
    discard: () => send("discard"),
  };
}
