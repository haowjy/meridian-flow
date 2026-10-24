/** The chat's pending changes and creation-bound Work commands. Selective items send complete classes; whole-draft items send whole commands. No disposition navigates. */
import { t } from "@lingui/core/macro";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useWorkBranchDrafts } from "@/client/query/useWorkBranchDrafts";
import {
  type DraftImagePreviewTarget,
  isDraftImagePath,
} from "@/features/draft-review/DraftImagePreview";
import { isDeletedFromManuscript } from "@/features/draft-review/deleted-drafts";
import type { BranchCommandFailure } from "@/features/draft-review/review-command-types";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import {
  listedItemChanges,
  type ReviewChange,
  targetOfChanges,
} from "@/features/draft-review/review-model";
import { hasTreeLine } from "@/features/draft-review/tree-line";
import { useRoomReviews } from "@/features/draft-review/useRoomReview";
import { useBoundWorkBranchCommands } from "@/features/draft-review/useWorkBranchCommands";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { type DockFile, dockFile, isOnStrip, totalChanges } from "./draft-dock-files";

export type DraftDockModel = ReturnType<typeof useDraftDock>;

export function useDraftDock({
  threadId,
  generating,
  active = true,
}: {
  threadId: string;
  generating: boolean;
  active?: boolean;
}) {
  const controller = useBoundWorkBranchCommands();
  useSyncExternalStore(
    controller.owner.subscribe,
    controller.owner.snapshot,
    controller.owner.snapshot,
  );
  const dismiss = useRef(controller.dismissNotice);
  useLayoutEffect(() => {
    dismiss.current = controller.dismissNotice;
  }, [controller.dismissNotice]);
  useEffect(() => {
    if (!active) dismiss.current();
    return () => dismiss.current();
  }, [active, threadId]);
  const listedFiles = useWorkBranchDrafts(controller.projectId, controller.workId).files ?? [];
  const { openReviewFile } = useAiDraftLauncher();
  const runner = controller;
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
        .filter((row) => row.draft.hasDraft && row.draft.tree?.deleted !== true)
        .map((row) => ({
          projectId,
          workId,
          documentId: row.documentId,
          itemKey: row.draft.itemKey,
        })),
    [candidates, projectId, workId],
  );
  // The open review keeps its own refresh; the strip refreshes the rest.
  const reads = useRoomReviews(targets);
  const untitled = t`Document`;
  const files = candidates
    .map((row) => {
      const read = reads[targets.findIndex((target) => target.itemKey === row.draft.itemKey)];
      const withoutText = row.draft.hasDraft === false || row.draft.tree?.deleted === true;
      const file = dockFile(
        row,
        reviewFileTargetName(row, untitled),
        {
          status: withoutText ? "ready" : (read?.status ?? "loading"),
          items: listedItemChanges(row.draft, read?.listedChanges ?? []).map((change) => ({
            change,
          })),

          retry: read?.retry,
        },
        threadId,
      );
      return controller.owner.state(row.draft.itemKey).discarding
        ? { ...file, actionable: [] }
        : file;
    })
    .filter(
      (file) =>
        !controller.owner.state(file.row.draft.itemKey).hidden &&
        (isOnStrip(file) ||
          controller.owner.state(file.row.draft.itemKey).pending ||
          controller.owner.state(file.row.draft.itemKey).failure),
    );

  const actionableFiles = files.filter((file) => file.actionable.length > 0);

  const review = useCallback(
    (file: DockFile, change?: ReviewChange) => {
      controller.dismissNotice();
      // A draft-only picture has no review room: it opens as a preview.
      if (!file.row.draft.hasDraft && file.row.draft.tree?.deleted !== true) {
        if (isDraftImagePath(file.row.contextLocation?.path))
          setImagePreview({ projectId, workId, documentId: file.row.documentId, name: file.name });
        return;
      }
      openReviewFile(file.row, workId, change ?? file.changes[0]);
    },
    [openReviewFile, projectId, workId],
  );

  const applicable = actionableFiles.filter(
    (file) => file.row.draft.hasDraft || file.row.draft.isNew || hasTreeLine(file.row.draft),
  );

  /**
   * Sends the strip's command. An Apply brings back only the deleted documents in `restore`;
   * it resolves to the files a delete the strip hadn't shown yet held back (`needs-restore`).
   */
  const send = useCallback(
    (mode: "apply" | "discard", restore: ReadonlySet<string> = new Set()) => {
      const files = mode === "apply" ? applicable : actionableFiles;
      const items = files.map((file) => ({
        draft: { documentId: file.row.documentId, itemKey: file.row.draft.itemKey },
        target: targetOfChanges(file.actionable),
      }));
      if (items.length === 0) return Promise.resolve([]);
      // The runner hides every file's selection at the click and returns each as
      // its own command answers; the records carry the outcomes.
      return runner.batch(mode, items, restore).then(
        (outcomes) => files.filter((_file, index) => outcomes[index]?.kind === "needs-restore"),
        () => [],
      );
    },
    [actionableFiles, applicable, runner],
  );

  const fileFailures = (file: DockFile): BranchCommandFailure[] => {
    const failure = controller.owner.state(file.row.draft.itemKey).failure;
    return failure ? [failure] : [];
  };

  return {
    generating,
    controller,
    files,
    mounted: files.length > 0 || controller.notice !== null,
    changeCount: totalChanges(files),
    /** Unread previews keep the controls visible but disabled until their scope is known. */
    showCommands: actionableFiles.length > 0 || files.some((file) => file.status !== "ready"),
    canApply: applicable.some(
      (file) =>
        (!file.row.draft.hasDraft && file.row.draft.isNew) ||
        hasTreeLine(file.row.draft) ||
        (reads[targets.findIndex((target) => target.itemKey === file.row.draft.itemKey)]?.frame
          ?.groups.length ?? 0) > 0,
    ),
    canCommand: actionableFiles.length > 0 && !generating && !controller.dispositionLocked,
    projectId,
    workId,
    fileFailures,
    review,
    imagePreview,
    closeImagePreview: () => setImagePreview(null),
    /** The files Apply would bring back from a delete; more than one file asks first. */
    deletedToApply: applicable.filter((file) => isDeletedFromManuscript(file.row.draft)),
    /** The files Apply would delete from the manuscript; more than one file asks first. */
    deletingToApply: applicable.filter((file) => file.row.draft.tree?.deleted === true),
    apply: (restore: ReadonlySet<string>) => send("apply", restore),
    discard: () => void send("discard"),
  };
}
