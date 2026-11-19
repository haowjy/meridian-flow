/** The chat's pending changes and creation-bound Work commands. Selective items send complete classes; whole-draft items send whole commands. No disposition navigates. */
import { t } from "@lingui/core/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { refreshTurnCards } from "@/client/query/useTurnLiveLineage";
import { useDraftNotice } from "@/features/draft-review/CommandNotice";
import type { DraftImagePreviewTarget } from "@/features/draft-review/DraftImagePreview";
import { isDeletedLive } from "@/features/draft-review/deleted-drafts";
import { hasLine } from "@/features/draft-review/draft-notices";
import type { BranchCommandFailure } from "@/features/draft-review/review-command-types";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import {
  listedItemChanges,
  type ReviewChange,
  targetOfChanges,
} from "@/features/draft-review/review-model";
import { hasApply, hasTreeLine, reviewHasNoRoom } from "@/features/draft-review/tree-line";
import { useRoomReviews } from "@/features/draft-review/useRoomReview";
import { useBoundWorkBranchCommands } from "@/features/draft-review/useWorkBranchCommands";
import { useAiDraftLauncher } from "@/features/project/review-launch";
import { useSidebarTabs } from "@/features/project/shell/sidebar/sidebar-tabs-store";
import { reviewCount, useShellTreeVersion } from "@/features/project/tree-version";
import { useWorkScope } from "@/features/project/use-work-scope";
import {
  type DockFile,
  dockFile,
  isOnStrip,
  isSharedDraft,
  totalChanges,
  wholeDockFile,
} from "./draft-dock-files";

/**
 * Rows that hold a review room, for their change-level detail and per-change commands: the first
 * eight, and every row whose draft is shared (see `isSharedDraft`). A room is a WebSocket, and a
 * chat that touched hundreds of drafts must not open them all (#1688): the rest read the owner
 * list and take whole-draft commands, as Changes does, which is exactly this chat's changes
 * because nobody else wrote in them.
 */
const ROOM_ROWS = 8;

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
  const shell = useShellTreeVersion();
  useSyncExternalStore(
    controller.owner.subscribe,
    controller.owner.snapshot,
    controller.owner.snapshot,
  );
  // The owner's notice, if this chat's strip made it.
  const owned = useDraftNotice(controller.ownerKey);
  const here =
    active && owned?.surface.kind === "strip" && owned.surface.threadId === threadId ? owned : null;
  const notice = here && hasLine(here) ? here : null;
  const listedFiles = useOwnerDrafts(controller.projectId, controller.ownerKey).files ?? [];
  const { openReviewFile } = useAiDraftLauncher();
  const runner = controller;
  const [imagePreview, setImagePreview] = useState<DraftImagePreviewTarget | null>(null);
  const { projectId, ownerKey } = controller;
  const { setWorkId } = useWorkScope(projectId);

  const candidates = useMemo(
    () =>
      listedFiles.filter((row) =>
        row.draft.actorThreads.some((chat) => chat.threadId === threadId),
      ),
    [listedFiles, threadId],
  );
  // A peer's Apply or Discard reaches this chat only as a change in which drafts wait here.
  const queryClient = useQueryClient();
  const waiting = candidates
    .filter((row) => row.draft.hasDraft)
    .map((row) => row.draft.itemKey)
    .join();
  const seenWaiting = useRef(waiting);
  useEffect(() => {
    if (seenWaiting.current === waiting) return;
    seenWaiting.current = waiting;
    refreshTurnCards(queryClient);
  }, [queryClient, waiting]);
  const targets = useMemo(
    () =>
      candidates
        .filter((row) => row.draft.hasDraft && row.draft.tree?.deleted !== true)
        .map((row) => ({
          projectId,
          ownerKey,
          documentId: row.documentId,
          itemKey: row.draft.itemKey,
        })),
    [candidates, projectId, ownerKey],
  );
  // The open review keeps its own refresh; the strip refreshes the rest.
  const roomed = useMemo(
    () =>
      targets.filter(
        (target, index) =>
          index < ROOM_ROWS ||
          isSharedDraft(
            candidates.find((row) => row.draft.itemKey === target.itemKey)?.draft,
            threadId,
          ),
      ),
    [targets, candidates, threadId],
  );
  const reads = useRoomReviews(roomed);
  const untitled = t`Document`;
  const roomIndex = (itemKey: string) => roomed.findIndex((target) => target.itemKey === itemKey);
  const drafted = candidates.map((row) => {
    const isWhole =
      row.draft.hasDraft && row.draft.tree?.deleted !== true && roomIndex(row.draft.itemKey) < 0;
    if (isWhole) {
      const file = wholeDockFile(row, reviewFileTargetName(row, untitled));
      return controller.owner.state(row.draft.itemKey).discarding
        ? { ...file, count: 0, actionable: [] }
        : file;
    }
    const read = reads[roomIndex(row.draft.itemKey)];
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
  });
  const files = drafted.filter((file) => {
    const state = controller.owner.state(file.row.draft.itemKey);
    // A command in flight hides its row, until its delivery needs the writer's Retry.
    if (state.hidden && !state.stalled) return false;
    return isOnStrip(file) || state.pending || state.failure;
  });
  // What the Changes list holds beyond this chat's: its items (documents and folders), less the
  // documents the strip's Apply would empty. Counted over the listed drafts, not the rows on
  // screen, so an Apply in flight doesn't count its own documents as more.
  const { work } = controller;
  const workCount =
    shell?.ownerKey === ownerKey
      ? shell.changeCount
      : work && !work.isNoWork
        ? reviewCount(shell, work)
        : null;
  const more =
    workCount === null || drafted.some((file) => file.status !== "ready")
      ? 0
      : Math.max(0, workCount - drafted.filter((file) => file.alone).length);

  const actionableFiles = files.filter((file) =>
    file.whole ? file.count > 0 : file.actionable.length > 0,
  );

  const review = useCallback(
    (file: DockFile, change?: ReviewChange) => {
      // A draft-only picture has no review room: it opens as a preview.
      if (!file.row.draft.hasDraft && !reviewHasNoRoom(file.row.draft)) {
        if (file.row.draft.binary)
          setImagePreview({
            projectId,
            ownerKey,
            documentId: file.row.documentId,
            name: file.name,
          });
        return;
      }
      openReviewFile(file.row, ownerKey, change ?? file.changes[0]);
    },
    [openReviewFile, projectId, ownerKey],
  );

  const applicable = actionableFiles.filter((file) => hasApply(file.row.draft));

  const discardItems = (files: readonly DockFile[]) => {
    // A frozen owner's draft takes only the whole draft's Discard, which the server ends.
    const whole = controller.frozen;
    return files.map((file) => ({
      draft: { documentId: file.row.documentId, itemKey: file.row.draft.itemKey },
      target: whole || file.whole ? ({ kind: "draft" } as const) : targetOfChanges(file.actionable),
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
              draft: { documentId: file.row.documentId, itemKey: file.row.draft.itemKey },
              target: file.whole ? ({ kind: "draft" } as const) : targetOfChanges(file.actionable),
            }));
      if (items.length === 0) return;
      // An Apply is one command over every file; a Discard is one notice with one Undo.
      void (mode === "apply" ? runner.applyMany(items) : runner.discardMany(items));
    },
    [actionableFiles, applicable, runner, controller.frozen],
  );

  const fileFailures = (file: DockFile): BranchCommandFailure[] => {
    const failure = controller.owner.state(file.row.draft.itemKey).failure;
    return failure ? [failure] : [];
  };

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
      if (work && shell?.ownerKey !== ownerKey) setWorkId(work.id);
      useSidebarTabs.getState().reveal("changes");
    },
    /** Unread previews keep the controls visible but disabled until their scope is known. */
    showCommands: actionableFiles.length > 0 || files.some((file) => file.status !== "ready"),
    canApply:
      controller.canApply &&
      applicable.some(
        (file) =>
          (!file.row.draft.hasDraft && file.row.draft.isNew) ||
          hasTreeLine(file.row.draft) ||
          isDeletedLive(file.row.draft) ||
          (file.whole
            ? file.row.draft.textChanges > 0
            : (reads[roomIndex(file.row.draft.itemKey)]?.frame?.groups.length ?? 0) > 0),
      ),
    canCommand: actionableFiles.length > 0 && !generating && !controller.dispositionLocked,
    projectId,
    ownerKey,
    fileFailures,
    review,
    imagePreview,
    closeImagePreview: () => setImagePreview(null),
    /** The files Apply would bring back from a delete; more than one file asks first. */
    deletedToApply: applicable.filter((file) => isDeletedLive(file.row.draft)),
    /** The files Apply would delete; more than one file asks first. */
    deletingToApply: applicable.filter((file) => file.row.draft.tree?.deleted === true),
    apply: () => send("apply"),
    discard: () => send("discard"),
    /** A listed (`whole`) row's own commands: its whole draft, as the row has no changes to pick. */
    applyFile: (file: DockFile) => send("apply", file),
    discardFile: (file: DockFile) => send("discard", file),
  };
}
