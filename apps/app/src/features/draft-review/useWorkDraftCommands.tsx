/** Creation-bound Work commands, independent of an open review. Navigation remains an explicit UI effect. */
import type { Work } from "@meridian/contracts/works";
import { isWorkArchived } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  type CommandStart,
  type DraftBatchItem,
  type DraftCommandOutcome,
  type DraftSelection,
  newestKnownProposal,
  runDraftBatch,
  runDraftSelection,
  startDraftCommand,
} from "@/client/query/draft-command-executor";
import {
  currentDraftCommandRecords,
  type DraftClaim,
  draftCommandPendingIn,
  pendingDraftCommand,
  useDraftCommandRecords,
  wholeDraftCommandPendingIn,
} from "@/client/query/draft-command-record";
import { getContextTabs } from "@/client/stores";
import { routeTargetForTab } from "@/features/project/context/context-removal-planner";
import {
  useIsCurrentContextRoute,
  useOpenContextRoute,
} from "@/features/project/routing/ProjectNavigationContext";
import { useDraftOnlyLifecycle } from "./draft-only-lifecycle";
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
  const lifecycle = useDraftOnlyLifecycle(projectId);
  const openContextRoute = useOpenContextRoute();
  const isCurrentContextRoute = useIsCurrentContextRoute();
  const records = useDraftCommandRecords();
  const isDisposing = draftCommandPendingIn(records, { projectId, workId });
  const frozen = !work || isWorkArchived(work);
  // A change's own Apply and Discard queue behind each other; only a command on
  // the whole draft, or a batch, holds them back.
  const changesLocked = frozen || wholeDraftCommandPendingIn(records, { projectId, workId });
  const commands = useMemo(() => {
    const scope = { projectId, workId };
    const whole = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      reserved: DraftClaim | null = null,
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
          completesDraft: true,
        },
        threadId,
        reserved,
        () => {
          if (mode === "discard") lifecycle.remove(target);
        },
      );
      return {
        ...start,
        outcome: start.outcome.then((outcome) => {
          if (outcome.kind === "applied") {
            const newest = newestKnownProposal(queryClient, target);
            if (newest === undefined || (generation !== undefined && newest <= generation)) {
              void (async () => {
                try {
                  await lifecycle.promote(target);
                  if (tab?.kind !== "tracked") return;
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
    const batch = (
      mode: "apply" | "discard",
      items: readonly (DraftSelection | { draft: DraftReviewSelection; wholeDraft: true })[],
    ) =>
      runDraftBatch(
        scope,
        mode,
        items.map(
          (item): DraftBatchItem =>
            "wholeDraft" in item
              ? {
                  draft: item.draft,
                  command: {
                    target: "all",
                    mode,
                    draftGeneration: newestKnownProposal(queryClient, { ...scope, ...item.draft }),
                    completesDraft: true,
                  },
                }
              : item,
        ),
        (item, claim) =>
          item.command
            ? whole(mode, item.draft, claim).outcome
            : selection(mode, item.draft, item.selection),
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
      applyBatch: (
        items: readonly (DraftSelection | { draft: DraftReviewSelection; wholeDraft: true })[],
      ) => batch("apply", items),
      discardBatch: (
        items: readonly (DraftSelection | { draft: DraftReviewSelection; wholeDraft: true })[],
      ) => batch("discard", items),
      disposeDrafts: async (mode: "apply" | "discard", drafts: readonly DraftReviewSelection[]) =>
        (
          await runDraftBatch(
            scope,
            mode,
            drafts.map((draft) => ({
              draft,
              command: {
                target: "all" as const,
                mode,
                draftGeneration: newestKnownProposal(queryClient, { ...scope, ...draft }),
                completesDraft: true,
              },
            })),
            ({ draft }, claim) => whole(mode, draft, claim).outcome,
          )
        ).map(({ outcome }) => outcome),
    };
  }, [
    projectId,
    workId,
    threadId,
    frozen,
    queryClient,
    lifecycle,
    openContextRoute,
    isCurrentContextRoute,
  ]);
  return { ...commands, isDisposing, dispositionLocked: isDisposing || frozen, changesLocked };
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
