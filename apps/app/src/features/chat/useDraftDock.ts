/**
 * The chat's pending changes and creation-bound Work commands. The strip lists the drafts the chat wrote
 * into (the server's SQL-only list), projects a file's changes only when it is expanded, applies only the
 * changes the attribution hint names this chat for, and never navigates on Apply. Discard on the strip happens
 * in place: the row reads "Discarded" with Undo until the writer leaves.
 */
import { t } from "@lingui/core/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  type DraftCommandFailure,
  draftCommandFailure,
  pendingDraftCommand,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { type DraftMeta, draftMetaQueryOptions } from "@/client/query/useDraftMeta";
import { useThreadDraftFiles } from "@/client/query/useWorkDrafts";
import { acquireChatChanges } from "@/features/draft-review/chat-changes";
import {
  type DraftImagePreviewTarget,
  isDraftImagePath,
} from "@/features/draft-review/DraftImagePreview";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import { useHeadlessDiscards } from "@/features/draft-review/useHeadlessDiscards";
import { useBoundWorkDraftCommands } from "@/features/draft-review/useWorkDraftCommands";
import { useLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { type DockFile, dockFiles } from "./draft-dock-files";

export type DraftDockModel = ReturnType<typeof useDraftDock>;

/** A failure held on the draft itself (a command from another surface, or a Review that did not open). */
export type DockFileFailure = { kind: "draft"; failure: DraftCommandFailure };

export function useDraftDock({ threadId, generating }: { threadId: string; generating: boolean }) {
  const controller = useBoundWorkDraftCommands();
  const listedFiles = useThreadDraftFiles(controller.projectId, controller.workId, threadId);
  const queryClient = useQueryClient();
  const registry = useLiveDocumentSessionRegistry();
  const { openReviewFile } = useAiDraftLauncher();
  const records = useDraftCommandRecords();
  const { projectId, workId } = controller;
  const discards = useHeadlessDiscards(projectId, workId);
  const [imagePreview, setImagePreview] = useState<DraftImagePreviewTarget | null>(null);

  const untitled = t`Document`;
  const chatFiles = useMemo(
    () => dockFiles(listedFiles, (row) => reviewFileTargetName(row, untitled)),
    [listedFiles, untitled],
  );
  // A file stays on the strip while one of its Discards can still be undone, even once it lists no changes.
  const discardedFiles = discards.entries.filter((entry) => entry.change === null);
  const files = useMemo(() => {
    const whole = new Set(discardedFiles.map((entry) => entry.file.draft.itemKey));
    const kept = chatFiles.filter((file) => !whole.has(file.row.draft.itemKey));
    const listed = new Set(kept.map((file) => file.row.draft.itemKey));
    const unlisted = discards.entries
      .filter((entry) => entry.change && !whole.has(entry.file.draft.itemKey))
      .filter(
        (entry, at, all) =>
          all.findIndex((o) => o.file.draft.itemKey === entry.file.draft.itemKey) === at,
      )
      .filter((entry) => !listed.has(entry.file.draft.itemKey))
      .map((entry) => ({ row: entry.file, name: reviewFileTargetName(entry.file, untitled) }));
    return [...kept, ...unlisted];
  }, [chatFiles, discards.entries, discardedFiles, untitled]);

  const review = useCallback(
    (file: DockFile, changeId?: string) => {
      // A draft-only picture has no review room: it opens as a preview.
      const meta = queryClient.getQueryData<DraftMeta>(
        draftMetaQueryOptions({
          projectId,
          workId,
          documentId: file.row.documentId,
          itemKey: file.row.draft.itemKey,
        }).queryKey,
      );
      if (file.row.draft.binary || meta?.kind === "branchless") {
        if (isDraftImagePath(file.row.contextLocation?.path))
          setImagePreview({ projectId, workId, documentId: file.row.documentId, name: file.name });
        return;
      }
      openReviewFile(file.row, workId, changeId ? [changeId] : undefined);
    },
    [openReviewFile, queryClient, projectId, workId],
  );

  // A whole item (created, binary, live-deleted) applies as the item; a text item applies the changes this
  // chat's edits overlap, never another chat's changes in the same file.
  const apply = useCallback(() => {
    for (const file of chatFiles) {
      const selection = { documentId: file.row.documentId, itemKey: file.row.draft.itemKey };
      if (file.row.draft.wholeItem) void controller.applyDraft(selection).outcome;
      else
        void controller.applyChatChanges(selection, () =>
          acquireChatChanges(registry, queryClient, { projectId, workId, ...selection }, threadId),
        );
    }
  }, [controller, chatFiles, registry, queryClient, projectId, workId, threadId]);

  // A text item's Discard is an edit of its room with Undo on the row, of this chat's changes only; a
  // whole item has no base to return to and closes (item Discard).
  const discard = useCallback(() => {
    for (const file of chatFiles) {
      if (file.row.draft.wholeItem)
        void controller.discardDraft({
          documentId: file.row.documentId,
          itemKey: file.row.draft.itemKey,
        }).outcome;
      else discards.discardFile(file.row, threadId);
    }
  }, [controller, chatFiles, discards, threadId]);

  const fileFailures = (file: DockFile): DockFileFailure[] => {
    const held = draftCommandFailure(records, {
      projectId,
      workId,
      documentId: file.row.documentId,
      itemKey: file.row.draft.itemKey,
    });
    return held ? [{ kind: "draft", failure: held }] : [];
  };

  return {
    generating,
    controller,
    files,
    discards,
    discardedFiles,
    imagePreview,
    closeImagePreview: () => setImagePreview(null),
    mounted: files.length + discardedFiles.length > 0,
    showCommands: chatFiles.length > 0,
    /** A whole-draft command in flight on any of the chat's files, said on the strip while it is collapsed. */
    pendingMode:
      chatFiles
        .map((file) =>
          pendingDraftCommand(records, {
            projectId,
            workId,
            documentId: file.row.documentId,
            itemKey: file.row.draft.itemKey,
          }),
        )
        .find((pending) => pending)?.mode ?? null,
    canCommand:
      chatFiles.length > 0 &&
      !generating &&
      !controller.dispositionLocked &&
      !chatFiles.some((file) =>
        pendingDraftCommand(records, {
          projectId,
          workId,
          documentId: file.row.documentId,
          itemKey: file.row.draft.itemKey,
        }),
      ),
    threadId,
    projectId,
    workId,
    fileFailures,
    review,
    apply,
    discard,
  };
}
