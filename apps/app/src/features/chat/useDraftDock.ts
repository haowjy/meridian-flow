/** The chat's pending changes and creation-bound Work commands. Selective items send complete classes; whole-draft items send whole commands. No disposition navigates. */
import { t } from "@lingui/core/macro";
import { useCallback, useMemo, useState } from "react";
import {
  type BranchCommandFailure,
  branchCommandFailure,
  type ChangeCommandState,
  changeCommandState,
  useChangeCommandRecords,
} from "@/client/query/branch-command-record";
import { useDraftPreviews } from "@/client/query/useDraftPreview";
import { useWorkBranches } from "@/client/query/useWorkBranches";
import { selectionOf } from "@/features/draft-review/change-selection";
import {
  type DraftImagePreviewTarget,
  isDraftImagePath,
} from "@/features/draft-review/DraftImagePreview";
import { usePresentedDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { type ReviewChange, targetOfChanges } from "@/features/draft-review/review-changes";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import { useBoundWorkBranchCommands } from "@/features/draft-review/useWorkBranchCommands";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { type DockFile, dockFile, isOnStrip, totalChanges } from "./draft-dock-files";

export type DraftDockModel = ReturnType<typeof useDraftDock>;

/** Failures held on a file: selective commands and the draft itself (including Review launches). */
export type DockFileFailure =
  | { kind: "changes"; failure: Extract<ChangeCommandState, { phase: "failed" }> }
  | { kind: "draft"; failure: BranchCommandFailure };

export function useDraftDock({ threadId, generating }: { threadId: string; generating: boolean }) {
  const controller = useBoundWorkBranchCommands();
  const listedFiles = useWorkBranches(controller.projectId, controller.workId).files ?? [];
  const presented = usePresentedDraftReview().controller;
  const { openReviewFile } = useAiDraftLauncher();
  const runner = controller;
  const records = useChangeCommandRecords();
  const [imagePreview, setImagePreview] = useState<DraftImagePreviewTarget | null>(null);
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
      candidates
        .filter((row) => row.draft.draftGeneration !== null)
        .map((row) => ({
          projectId,
          workId,
          documentId: row.documentId,
          itemKey: row.draft.itemKey,
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
        .map((row, _index) =>
          dockFile(
            row,
            reviewFileTargetName(row, untitled),
            entries[targets.findIndex((target) => target.itemKey === row.draft.itemKey)],
            threadId,
          ),
        )
        .filter(isOnStrip),
    [candidates, entries, targets, threadId, untitled],
  );
  const actionableFiles = files.filter((file) => file.actionable.length > 0);

  const review = useCallback(
    (file: DockFile, change?: ReviewChange) => {
      // A draft-only picture has no review room: it opens as a preview.
      if (file.row.draft.draftGeneration === null) {
        if (isDraftImagePath(file.row.contextLocation?.path))
          setImagePreview({ projectId, workId, documentId: file.row.documentId, name: file.name });
        return;
      }
      openReviewFile(file.row, workId, change?.operationIds ?? file.changes[0]?.operationIds);
    },
    [openReviewFile, projectId, workId],
  );

  const send = useCallback(
    (mode: "apply" | "discard") => {
      const items = actionableFiles.map((file) => ({
        draft: { documentId: file.row.documentId, itemKey: file.row.draft.itemKey },
        target: targetOfChanges(file.actionable),
      }));
      if (items.length === 0) return;
      // The runner hides every file's selection at the click and returns each as
      // its own command answers; the records carry the outcomes.
      const batch = mode === "apply" ? runner.applyBatch(items) : runner.discardBatch(items);
      void batch.catch(() => {});
    },
    [actionableFiles, runner],
  );

  const fileFailures = (file: DockFile): DockFileFailure[] => {
    const ref = {
      projectId,
      workId,
      documentId: file.row.documentId,
      itemKey: file.row.draft.itemKey,
    };
    const state = changeCommandState(records, ref, selectionOf(file.changes));
    const held = branchCommandFailure(records.branches, ref);
    return [
      ...(state?.phase === "failed" ? [{ kind: "changes" as const, failure: state }] : []),
      ...(held ? [{ kind: "draft" as const, failure: held }] : []),
    ];
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
    projectId,
    workId,
    fileFailures,
    review,
    imagePreview,
    closeImagePreview: () => setImagePreview(null),
    apply: () => send("apply"),
    discard: () => send("discard"),
  };
}
