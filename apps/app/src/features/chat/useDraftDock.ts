/** The chat's pending changes and creation-bound Work commands. Selective items send complete classes; whole-draft items send whole commands. No disposition navigates. */
import { t } from "@lingui/core/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { refreshTurnCards } from "@/client/query/useTurnLiveLineage";
import { useDraftNotice, useNoticeLine } from "@/features/draft-review/CommandNotice";
import type { DraftImagePreviewTarget } from "@/features/draft-review/DraftImagePreview";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import {
  listedItemChanges,
  type ReviewChange,
  targetOfChanges,
} from "@/features/draft-review/review-model";
import { hasApply, hasTreeLine, opensAsDocument } from "@/features/draft-review/tree-line";
import { useBoundWorkDraftCommands } from "@/features/draft-review/usePressCommands";
import { useItemLauncher } from "@/features/project/review-launch";
import { useSidebarTabs } from "@/features/project/shell/sidebar/sidebar-tabs-store";
import { reviewCount, useShellTreeVersion } from "@/features/project/tree-version";
import { useWorkScope } from "@/features/project/use-work-scope";
import {
  type DockFile,
  dockFile,
  isOnStrip,
  isSharedItem,
  totalChanges,
  wholeDockFile,
} from "./draft-dock-files";

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
  const controller = useBoundWorkDraftCommands();
  const shell = useShellTreeVersion();
  useSyncExternalStore(
    controller.owner.subscribe,
    controller.owner.snapshot,
    controller.owner.snapshot,
  );
  // The owner's notice, if this chat's strip made it.
  const owned = useDraftNotice(controller.draftId);
  const here =
    active && owned?.surface.kind === "strip" && owned.surface.threadId === threadId ? owned : null;
  const notice = useNoticeLine(here);
  const listedFiles = useOwnerDrafts(controller.projectId, controller.draftId).files ?? [];
  const { openReviewFile } = useItemLauncher();
  const runner = controller;
  const [imagePreview, setImagePreview] = useState<DraftImagePreviewTarget | null>(null);
  const { projectId, draftId } = controller;
  const { setWorkId } = useWorkScope(projectId);

  const candidates = useMemo(
    () =>
      listedFiles.filter((row) => row.item.actorThreads.some((chat) => chat.threadId === threadId)),
    [listedFiles, threadId],
  );
  // A peer's Apply or Discard reaches this chat only as a change in which drafts wait here.
  const queryClient = useQueryClient();
  const waiting = candidates
    .filter((row) => row.item.textChanges > 0)
    .map((row) => row.item.itemKey)
    .join();
  const seenWaiting = useRef(waiting);
  useEffect(() => {
    if (seenWaiting.current === waiting) return;
    seenWaiting.current = waiting;
    refreshTurnCards(queryClient);
  }, [queryClient, waiting]);
  const untitled = t`Document`;
  const drafted = candidates.map((row) => {
    // A document with text is pressed whole; one another chat drafted too is reviewed in the
    // Changes list, not pressed from here as this chat's.
    if (row.item.textChanges > 0 && row.item.tree?.deleted !== true) {
      const file = wholeDockFile(row, reviewFileTargetName(row, untitled));
      return isSharedItem(row.item, threadId)
        ? { ...file, count: 0, actionable: [], alone: false }
        : file;
    }
    // A move or a delete: its tree line is its one change.
    return dockFile(
      row,
      reviewFileTargetName(row, untitled),
      listedItemChanges(row.item, []),
      threadId,
    );
  });
  // A press in flight hides its rows.
  const files = drafted.filter(
    (file) => !controller.owner.state(file.row.item.itemKey).hidden && isOnStrip(file),
  );
  // What the Changes list holds beyond this chat's: its items (documents and folders), less the
  // documents the strip's Apply would empty. Counted over the listed drafts, not the rows on
  // screen, so an Apply in flight doesn't count its own documents as more.
  const { work } = controller;
  const workCount =
    shell?.draftId === draftId
      ? shell.changeCount
      : work && !work.isNoWork
        ? reviewCount(shell, work)
        : null;
  const more =
    workCount === null ? 0 : Math.max(0, workCount - drafted.filter((file) => file.alone).length);

  const actionableFiles = files.filter((file) =>
    file.whole ? file.count > 0 : file.actionable.length > 0,
  );

  const review = useCallback(
    (file: DockFile, change?: ReviewChange) => {
      // A draft-only picture opens as a preview; a created document opens like any other.
      if (!opensAsDocument(file.row.item)) {
        if (file.row.item.binary)
          setImagePreview({
            projectId,
            draftId,
            documentId: file.row.documentId,
            name: file.name,
          });
        return;
      }
      openReviewFile(file.row, draftId, change ?? file.changes[0]);
    },
    [openReviewFile, projectId, draftId],
  );

  const applicable = actionableFiles.filter((file) => hasApply(file.row.item));

  const discardItems = (files: readonly DockFile[]) => {
    return files.map((file) => ({
      item: { documentId: file.row.documentId, itemKey: file.row.item.itemKey },
      target: file.whole ? ({ kind: "draft" } as const) : targetOfChanges(file.actionable),
    }));
  };
  /** Sends the strip's command. */
  const send = useCallback(
    (mode: "apply" | "discard", only?: DockFile) => {
      const files = only ? [only] : mode === "apply" ? applicable : actionableFiles;
      const items =
        mode === "discard"
          ? discardItems(files)
          : files.map((file) => ({
              item: { documentId: file.row.documentId, itemKey: file.row.item.itemKey },
              target: file.whole ? ({ kind: "draft" } as const) : targetOfChanges(file.actionable),
            }));
      if (items.length === 0) return;
      // An Apply is one command over every file; a Discard is one notice with one Undo.
      void (mode === "apply" ? runner.applyMany(items) : runner.discardMany(items));
    },
    [actionableFiles, applicable, runner],
  );

  return {
    generating,
    controller,
    files,
    notice,
    mounted: files.length > 0 || notice !== null,
    changeCount: totalChanges(files),
    /** The Changes list's items the strip's commands leave. */
    more,
    /** The chat's drafts are a named Work's, not its own. */
    inWork: work !== null && !work.isNoWork,
    /** Opens the sidebar's Changes list on this chat's Work, which acts on all of its changes. */
    showChanges: () => {
      if (work && shell?.draftId !== draftId) setWorkId(work.id);
      useSidebarTabs.getState().reveal("changes");
    },
    showCommands: actionableFiles.length > 0,
    canApply: applicable.some(
      (file) =>
        (file.row.item.textChanges === 0 && file.row.item.isNew) ||
        hasTreeLine(file.row.item) ||
        (file.whole && file.row.item.textChanges > 0),
    ),
    canCommand: actionableFiles.length > 0 && !generating && !controller.dispositionLocked,
    projectId,
    draftId,
    review,
    imagePreview,
    closeImagePreview: () => setImagePreview(null),
    /** The files Apply would delete; more than one file asks first. */
    deletingToApply: applicable.filter((file) => file.row.item.tree?.deleted === true),
    apply: () => send("apply"),
    discard: () => send("discard"),
    /** A listed (`whole`) row's own commands: its whole draft, as the row has no changes to pick. */
    applyFile: (file: DockFile) => send("apply", file),
    discardFile: (file: DockFile) => send("discard", file),
  };
}
