/**
 * The chat's draft above its composer: every file the draft changes, as the Changes tab lists
 * them, and one Discard · Apply pair for the whole draft. What else the Work holds is a link to
 * the Changes tab. No command navigates.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useWorkDrafts } from "@/client/query/draft-commands";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { refreshTurnCards } from "@/client/query/useTurnLiveLineage";
import { useDraftNotice } from "@/features/draft-review/CommandNotice";
import { hasApply } from "@/features/draft-review/tree-line";
import { useBoundWorkDraftCommands } from "@/features/draft-review/usePressCommands";
import { useSidebarTabs } from "@/features/project/shell/sidebar/sidebar-tabs-store";
import { useShellTreeVersion } from "@/features/project/tree-version";
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
  // An Apply speaks only on its rows.
  const notice = here?.kind === "discarded" ? here : null;
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
  const applicable = files.filter((file) => hasApply(file.item));
  // What the Work's other drafts change, as their rows in the Changes tab count it.
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
    /** Opens the sidebar's Changes list on this chat's Work, which lists all of its drafts. */
    showChanges: () => {
      if (work && shell?.draftId !== draftId) setWorkId(work.id);
      useSidebarTabs.getState().reveal("changes");
    },
    canApply: applicable.length > 0,
    canCommand: files.length > 0 && !generating && !controller.dispositionLocked,
    /** The files Apply would delete; more than one file asks first. */
    deletingToApply: applicable.filter((file) => file.item.tree?.deleted === true),
    apply: () => void controller.pressDraft("apply"),
    discard: () => void controller.pressDraft("discard"),
  };
}
