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
  runWholeDraftIntent,
  runWorkWideCommand,
  startDraftCommand,
} from "@/client/query/draft-command-executor";
import type { DraftRef } from "@/client/query/draft-command-record";
import { getContextTabs, matchesReviewItem } from "@/client/stores";
import { routeTargetForTab } from "@/features/project/context/context-removal-planner";
import {
  useIsCurrentContextRoute,
  useOpenContextRoute,
} from "@/features/project/routing/ProjectNavigationContext";
import { useDraftOnlyLifecycle } from "./draft-only-lifecycle";
import type { DraftReviewSelection } from "./draft-review-session";
import type { ChangeTarget } from "./review-changes";

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
        ? Promise.resolve<DraftCommandOutcome>({ kind: "blocked" })
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
          : Promise.resolve<DraftCommandOutcome>({ kind: "blocked" });
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
      disposeDrafts: async (
        mode: "apply" | "discard",
        drafts: readonly DraftReviewSelection[],
      ): Promise<DraftCommandOutcome[]> => {
        if (frozen) return drafts.map(() => ({ kind: "blocked" }));
        const before = drafts.map((draft) => ({
          generation: newestKnownProposal(queryClient, refOf(draft)),
          tab: tabOf(draft),
        }));
        const outcomes = await runWorkWideCommand(queryClient, scope, mode, drafts, threadId);
        outcomes.forEach((outcome, index) => {
          if (outcome.kind === "discarded") lifecycle.remove(refOf(drafts[index]));
          if (outcome.kind === "applied")
            promoteIfSettled(refOf(drafts[index]), before[index].generation, before[index].tab);
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
