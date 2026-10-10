import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
/** Creation-bound Work commands, independent of an open review. Navigation remains an explicit UI effect. */
import type { Work } from "@meridian/contracts/works";
import { isWorkArchived } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  type CommandStart,
  type DraftCommandOutcome,
  type DraftSelection,
  newestKnownProposal,
  runDraftBatch,
  runDraftSelection,
  startDraftCommand,
} from "@/client/query/draft-command-executor";
import {
  currentDraftCommandRecords,
  draftCommandPendingIn,
  pendingDraftCommand,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { getContextTabs } from "@/client/stores";
import { useContextRemovalCoordinator } from "@/features/project/context/account-feature-context";
import { routeTargetForTab } from "@/features/project/context/context-removal-planner";
import {
  useIsCurrentContextRoute,
  useOpenContextRoute,
} from "@/features/project/routing/ProjectNavigationContext";
import type { DraftReviewSelection } from "./draft-review-session";

export type WorkDraftCommands = ReturnType<typeof useWorkDraftCommands>;

export function useWorkDraftCommands({
  projectId,
  work,
  threadId = null,
}: {
  projectId: string;
  work: Work | null;
  threadId?: string | null;
}) {
  const workId = work?.id ?? "";
  const queryClient = useQueryClient();
  const contextRemoval = useContextRemovalCoordinator();
  const openContextRoute = useOpenContextRoute();
  const isCurrentContextRoute = useIsCurrentContextRoute();
  const records = useDraftCommandRecords();
  const isDisposing = draftCommandPendingIn(records, { projectId, workId });
  const frozen = !work || isWorkArchived(work);
  const commands = useMemo(() => {
    const scope = { projectId, workId };
    const completesDraft = (draft: DraftReviewSelection) =>
      queryClient
        .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(projectId, workId))
        ?.find((row) => row.draftId === draft.draftId)?.isNewDocument !== true;
    const whole = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      batch = false,
      reserved = false,
    ): CommandStart => {
      if (frozen) return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
      const target = { ...scope, ...draft };
      const generation = reserved
        ? pendingDraftCommand(currentDraftCommandRecords(), target)?.draftGeneration
        : newestKnownProposal(queryClient, target);
      const tab = getContextTabs(projectId).tabs.find(
        (candidate) => candidate.documentId === draft.documentId,
      );
      const start = startDraftCommand(
        queryClient,
        {
          target: "all",
          draft: target,
          mode,
          generation,
          completesDraft: batch && completesDraft(draft),
        },
        threadId,
        reserved,
        () => {
          if (mode === "discard")
            contextRemoval.discardDraft(projectId, workId, draft.documentId, draft.draftId);
        },
      );
      return {
        ...start,
        outcome: start.outcome.then((outcome) => {
          if (outcome.kind === "applied" && tab?.kind === "tracked") {
            const newest = newestKnownProposal(queryClient, target);
            if (newest === undefined || (generation !== undefined && newest <= generation)) {
              void (async () => {
                try {
                  if (tab.draftOnly) await contextRemoval.promoteAppliedDraft(projectId, tab);
                  const route = routeTargetForTab(tab, workId);
                  if (openContextRoute && isCurrentContextRoute?.(route))
                    await openContextRoute(route, {
                      replace: true,
                      isCurrent: () => isCurrentContextRoute(route),
                    });
                } catch {
                  // Applied stays applied; the document host reconciles navigation.
                }
              })();
            }
          }
          return outcome;
        }),
      };
    };
    const selection = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      changes: DraftSelection["selection"],
    ) =>
      frozen
        ? Promise.resolve<DraftCommandOutcome>({ kind: "blocked" })
        : runDraftSelection(queryClient, scope, mode, draft, changes, threadId);
    const batch = (mode: "apply" | "discard", items: readonly DraftSelection[]) =>
      runDraftBatch(scope, items, ({ draft, selection: changes }) =>
        selection(mode, draft, changes),
      );
    return {
      projectId,
      workId,
      threadId,
      startDraft: (mode: "apply" | "discard", draft: DraftReviewSelection) => whole(mode, draft),
      apply: (documentId: string, draftId: string) =>
        whole("apply", { documentId, draftId }).outcome,
      discard: (documentId: string, draftId: string) =>
        whole("discard", { documentId, draftId }).outcome,
      applyChanges: (draft: DraftReviewSelection, changes: DraftSelection["selection"]) =>
        selection("apply", draft, changes),
      discardChanges: (draft: DraftReviewSelection, changes: DraftSelection["selection"]) =>
        selection("discard", draft, changes),
      applyBatch: (items: readonly DraftSelection[]) => batch("apply", items),
      discardBatch: (items: readonly DraftSelection[]) => batch("discard", items),
      disposeDrafts: async (mode: "apply" | "discard", drafts: readonly DraftReviewSelection[]) =>
        (
          await runDraftBatch(
            scope,
            drafts.map((draft) => ({
              draft,
              command: {
                target: "all" as const,
                mode,
                draftGeneration: newestKnownProposal(queryClient, { ...scope, ...draft }),
                ...(completesDraft(draft) ? { completesDraft: true as const } : {}),
              },
            })),
            ({ draft }) => whole(mode, draft, true, true).outcome,
          )
        ).map(({ outcome }) => outcome),
    };
  }, [
    projectId,
    workId,
    threadId,
    frozen,
    queryClient,
    contextRemoval,
    openContextRoute,
    isCurrentContextRoute,
  ]);
  return { ...commands, isDisposing, dispositionLocked: isDisposing || frozen };
}

const WorkDraftCommandsContext = createContext<WorkDraftCommands | null>(null);
export function WorkDraftCommandsBoundary({
  value,
  children,
}: {
  value: WorkDraftCommands;
  children: ReactNode;
}) {
  return (
    <WorkDraftCommandsContext.Provider value={value}>{children}</WorkDraftCommandsContext.Provider>
  );
}
export function useBoundWorkDraftCommands(): WorkDraftCommands {
  const commands = useContext(WorkDraftCommandsContext);
  if (!commands) throw new Error("Work commands require a WorkDraftCommandsBoundary");
  return commands;
}
