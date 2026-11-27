import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useWorkDrafts } from "@/client/query/draft-commands";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { refreshTurnCards } from "@/client/query/useTurnLiveLineage";
import { useDraftNotice } from "@/features/draft-review/CommandNotice";
import { hasApply } from "@/features/draft-review/tree-line";
import { useBoundWorkDraftCommands } from "@/features/draft-review/usePressCommands";
import { useSidebarTabs } from "@/features/project/shell/sidebar/sidebar-tabs-store";
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
  useSyncExternalStore(
    controller.owner.subscribe,
    controller.owner.snapshot,
    controller.owner.snapshot,
  );
  const { projectId, draftId, work } = controller;
  const owned = useDraftNotice(draftId);
  const here =
    active && owned?.surface.kind === "strip" && owned.surface.threadId === threadId ? owned : null;
  const notice = here;
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

  const files = listed;
  const applicable = files.filter((file) => hasApply(file.item));
  const workDrafts = useWorkDrafts(projectId, work && !work.isNoWork ? work.id : null).drafts;
  const more = (workDrafts ?? []).reduce(
    (sum, draft) =>
      draft.id === draftId ? sum : sum + draft.pendingDocumentCount + draft.pendingFolderCount,
    0,
  );

  return {
    controller,
    projectId,
    draftId,
    files,
    notice,
    mounted: files.length > 0 || notice !== null,
    more,
    showChanges: () => {
      if (work) setWorkId(work.id);
      useSidebarTabs.getState().reveal("changes");
    },
    canApply: applicable.length > 0,
    canCommand: files.length > 0 && !generating && !controller.dispositionLocked,
    deletingToApply: applicable.filter((file) => file.item.tree?.deleted === true),
    apply: () => void controller.pressDraft("apply"),
    discard: () => void controller.pressDraft("discard"),
  };
}
