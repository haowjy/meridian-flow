/**
 * The chat's draft above its composer: every file the draft changes, as the Changes tab lists
 * them, and one Discard · Apply pair for the whole draft. What else the Work holds is a link to
 * the Changes tab. No command navigates.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { refreshTurnCards } from "@/client/query/useTurnLiveLineage";
import { useDraftNotice, useNoticeLine } from "@/features/draft-review/CommandNotice";
import { hasApply } from "@/features/draft-review/tree-line";
import { useBoundWorkDraftCommands } from "@/features/draft-review/usePressCommands";
import { useSidebarTabs } from "@/features/project/shell/sidebar/sidebar-tabs-store";
import { reviewCount, useShellTreeVersion } from "@/features/project/tree-version";
import { useWorkScope } from "@/features/project/use-work-scope";

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
  const { projectId, draftId, work } = controller;
  // The owner's notice, if this chat's dock made it.
  const owned = useDraftNotice(draftId);
  const here =
    active && owned?.surface.kind === "strip" && owned.surface.threadId === threadId ? owned : null;
  const notice = useNoticeLine(here);
  const listed = useOwnerDrafts(projectId, draftId).files ?? [];
  const { setWorkId } = useWorkScope(projectId);

  // A peer's Apply or Discard reaches this chat only as a change in what its draft holds.
  const queryClient = useQueryClient();
  const waiting = listed.map((file) => file.item.itemKey).join();
  const seenWaiting = useRef(waiting);
  useEffect(() => {
    if (seenWaiting.current === waiting) return;
    seenWaiting.current = waiting;
    refreshTurnCards(queryClient);
  }, [queryClient, waiting]);

  // A press in flight hides its rows.
  const files = listed.filter((file) => !controller.owner.state(file.item.itemKey).hidden);
  const refs = files.map((file) => ({ documentId: file.documentId, itemKey: file.item.itemKey }));
  const applicable = files.filter((file) => hasApply(file.item));
  // The Work's other drafts' files, counted from the listed draft, so a press in flight doesn't
  // count its own files as more.
  const workCount = work && !work.isNoWork ? reviewCount(shell, work) : null;
  const more = workCount === null ? 0 : Math.max(0, workCount - listed.length);

  return {
    controller,
    projectId,
    draftId,
    files,
    notice,
    mounted: files.length > 0 || notice !== null,
    more,
    /** Opens the sidebar's Changes list on this chat's Work, which lists all of its drafts. */
    showChanges: () => {
      if (work && shell?.draftId !== draftId) setWorkId(work.id);
      useSidebarTabs.getState().reveal("changes");
    },
    canApply: applicable.length > 0,
    canCommand: files.length > 0 && !generating && !controller.dispositionLocked,
    /** The files Apply would delete; more than one file asks first. */
    deletingToApply: applicable.filter((file) => file.item.tree?.deleted === true),
    apply: () => void controller.applyMany(refs),
    discard: () => void controller.discardMany(refs),
  };
}
