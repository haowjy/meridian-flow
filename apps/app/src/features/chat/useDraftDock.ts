/** The chat's pending changes and creation-bound Work commands. Selective items send complete classes; whole-draft items send whole commands. No disposition navigates. */
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
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import { selectionOf } from "@/features/draft-review/change-selection";
import { usePresentedDraftReview } from "@/features/draft-review/DraftReviewProvider";
import type { ReviewChange } from "@/features/draft-review/review-changes";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import { useBoundWorkDraftCommands } from "@/features/draft-review/useWorkDraftCommands";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { type DockFile, dockFile, isOnStrip, totalChanges } from "./draft-dock-files";

export type DraftDockModel = ReturnType<typeof useDraftDock>;

/** What went wrong on a file: the strip's own command, else anything held on the draft (a failed Review launch). */
export type DockFileFailure =
  | { kind: "changes"; failure: Extract<ChangeCommandState, { phase: "failed" }> }
  | { kind: "draft"; failure: DraftCommandFailure };

export function useDraftDock({ threadId, generating }: { threadId: string; generating: boolean }) {
  const controller = useBoundWorkDraftCommands();
  const listedFiles = useWorkDrafts(controller.projectId, controller.workId).files ?? [];
  const presented = usePresentedDraftReview().controller;
  const { openReviewFile } = useAiDraftLauncher();
  const runner = controller;
  const records = useChangeCommandRecords();
  const { projectId, workId } = controller;

  const candidates = useMemo(
    () =>
      listedFiles.filter((row) =>
        row.draft.actorThreads.some((chat) => chat.threadId === threadId),
      ),
    [listedFiles, threadId],
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
  const open = presented.workId === workId ? presented.inlineReview : null;
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
  const actionableFiles = files.filter((file) => file.actionable.length > 0);

  const review = useCallback(
    (file: DockFile, change?: ReviewChange) => {
      openReviewFile(file.row, workId, change?.operationIds ?? file.changes[0]?.operationIds);
    },
    [openReviewFile, workId],
  );
  const reviewable = files.find((file) => file.row.contextPath) ?? null;

  const send = useCallback(
    (mode: "apply" | "discard") => {
      const items = actionableFiles.map((file) => ({
        draft: { documentId: file.row.documentId, draftId: file.row.draft.draftId },
        ...(file.actionable.some((change) => change.wholeDraft)
          ? { wholeDraft: true as const }
          : { selection: selectionOf(file.actionable) }),
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
    controller,
    files,
    mounted: files.length > 0,
    changeCount: totalChanges(files),
    /** Unread previews keep the controls visible but disabled until their scope is known. */
    showCommands: actionableFiles.length > 0 || files.some((file) => file.status !== "ready"),
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
