/** Creation-bound Work commands, independent of an open review. Navigation remains an explicit UI effect. */
import type { Work } from "@meridian/contracts/works";
import { isWorkArchived } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  type BranchCommandOutcome,
  type CommandStart,
  type DraftSelection,
  newestKnownProposal,
  runDraftBatch,
  runDraftSelection,
  runWholeDraftIntent,
  runWorkWideCommand,
  startBranchCommand,
} from "@/client/query/branch-command-executor";
import type { DraftRef } from "@/client/query/branch-command-record";
import { getContextTabs, matchesReviewItem } from "@/client/stores";
import { routeTargetForTab } from "@/features/project/context/context-removal-planner";
import {
  useIsCurrentContextRoute,
  useOpenContextRoute,
} from "@/features/project/routing/ProjectNavigationContext";
import { useDraftOnlyLifecycle } from "./draft-only-lifecycle";
import type { DraftReviewSelection } from "./draft-review-session";
import type { ChangeTarget } from "./review-changes";

export type WorkBranchCommands = ReturnType<typeof useWorkBranchCommands>;

export function useWorkBranchCommands({
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
  const frozen = !work || isWorkArchived(work);
  const changesLocked = frozen;
  const commands = useMemo(() => {
    const scope = { projectId, workId };
    /** An Apply that left no newer proposal promotes the draft-only document; the route follows. */
    const promoteIfSettled = (
      target: DraftRef,
      generation: number | undefined,
      tab: ReturnType<typeof getContextTabs>["tabs"][number] | undefined,
    ) => {
      const newest = newestKnownProposal(queryClient, target);
      if (newest !== undefined && generation !== undefined && newest > generation) return;
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
    };
    const refOf = (draft: DraftReviewSelection): DraftRef => ({
      ...scope,
      documentId: draft.documentId,
      itemKey: draft.itemKey,
    });
    const tabOf = (draft: DraftReviewSelection) =>
      getContextTabs(projectId).tabs.find((candidate) =>
        matchesReviewItem(candidate, { reviewWorkId: workId, reviewItemKey: draft.itemKey }),
      );
    const sendWhole = (mode: "apply" | "discard", draft: DraftReviewSelection): CommandStart => {
      if (frozen) return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
      const target = { ...scope, documentId: draft.documentId, itemKey: draft.itemKey };
      const generation = newestKnownProposal(queryClient, target);
      const tab = getContextTabs(projectId).tabs.find((candidate) =>
        matchesReviewItem(candidate, { reviewWorkId: workId, reviewItemKey: draft.itemKey }),
      );
      const start = startBranchCommand(
        queryClient,
        {
          target: "all",
          draft: target,
          mode,
          generation,
          completesDraft: true,
        },
        threadId,
      );
      return {
        ...start,
        outcome: start.outcome.then((outcome) => {
          if (outcome.kind === "applied") promoteIfSettled(target, generation, tab);
          if (outcome.kind === "discarded") {
            try {
              lifecycle.remove(target);
            } catch {
              /* The committed command must not be resent for route repair. */
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
        ? Promise.resolve<BranchCommandOutcome>({ kind: "blocked" })
        : runDraftSelection(queryClient, scope, mode, draft, changes, threadId);
    const whole = (mode: "apply" | "discard", draft: DraftReviewSelection) =>
      runWholeDraftIntent(
        { ...scope, documentId: draft.documentId, itemKey: draft.itemKey },
        mode,
        () => sendWhole(mode, draft),
      );
    const commandChange = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
    ) =>
      target.kind === "draft"
        ? whole(mode, draft).outcome
        : target.kind === "operations"
          ? selection(mode, draft, target.selection)
          : Promise.resolve<BranchCommandOutcome>({ kind: "blocked" });
    const batch = (
      mode: "apply" | "discard",
      items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
    ) => runDraftBatch(items, (item) => commandChange(mode, item.draft, item.target));
    return {
      commandChange,
      projectId,
      workId,
      threadId,
      startDraft: (mode: "apply" | "discard", draft: DraftReviewSelection) => whole(mode, draft),
      apply: (documentId: string, itemKey: string) =>
        whole("apply", { documentId, itemKey }).outcome,
      discard: (documentId: string, itemKey: string) =>
        whole("discard", { documentId, itemKey }).outcome,
      applyChanges: (draft: DraftReviewSelection, changes: DraftSelection["selection"]) =>
        selection("apply", draft, changes),
      discardChanges: (draft: DraftReviewSelection, changes: DraftSelection["selection"]) =>
        selection("discard", draft, changes),
      applyBatch: (items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[]) =>
        batch("apply", items),
      discardBatch: (items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[]) =>
        batch("discard", items),
      /** Work Files' Apply all and Discard all: one server command over the listed items. */
      disposeBranches: async (
        mode: "apply" | "discard",
        branches: readonly DraftReviewSelection[],
      ): Promise<BranchCommandOutcome[]> => {
        if (frozen) return branches.map(() => ({ kind: "blocked" }));
        const before = branches.map((draft) => ({
          generation: newestKnownProposal(queryClient, refOf(draft)),
          tab: tabOf(draft),
        }));
        const outcomes = await runWorkWideCommand(queryClient, scope, mode, branches, threadId);
        outcomes.forEach((outcome, index) => {
          if (outcome.kind === "discarded") lifecycle.remove(refOf(branches[index]));
          if (outcome.kind === "applied")
            promoteIfSettled(refOf(branches[index]), before[index].generation, before[index].tab);
        });
        return outcomes;
      },
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
  return { ...commands, dispositionLocked: frozen, changesLocked };
}

const WorkBranchCommandsContext = createContext<WorkBranchCommands | null>(null);
export function WorkBranchCommandsBoundary({
  value,
  children,
}: {
  value: WorkBranchCommands;
  children: ReactNode;
}) {
  return (
    <WorkBranchCommandsContext.Provider value={value}>
      {children}
    </WorkBranchCommandsContext.Provider>
  );
}
export function useBoundWorkBranchCommands(): WorkBranchCommands {
  const commands = useContext(WorkBranchCommandsContext);
  if (!commands) throw new Error("Work commands require a WorkBranchCommandsBoundary");
  return commands;
}
