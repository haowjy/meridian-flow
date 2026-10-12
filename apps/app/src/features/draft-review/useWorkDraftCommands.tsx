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
  startDraftCommand,
} from "@/client/query/draft-command-executor";
import { getContextTabs } from "@/client/stores";
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
    const sendWhole = (mode: "apply" | "discard", draft: DraftReviewSelection): CommandStart => {
      if (frozen) return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
      const target = { ...scope, documentId: draft.documentId, draftId: draft.draftId };
      const generation = newestKnownProposal(queryClient, target);
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
    const whole = (mode: "apply" | "discard", draft: DraftReviewSelection) =>
      runWholeDraftIntent(
        { ...scope, documentId: draft.documentId, draftId: draft.draftId },
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
      apply: (documentId: string, draftId: string) =>
        whole("apply", { documentId, draftId }).outcome,
      discard: (documentId: string, draftId: string) =>
        whole("discard", { documentId, draftId }).outcome,
      applyChanges: (draft: DraftReviewSelection, changes: DraftSelection["selection"]) =>
        selection("apply", draft, changes),
      discardChanges: (draft: DraftReviewSelection, changes: DraftSelection["selection"]) =>
        selection("discard", draft, changes),
      applyBatch: (items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[]) =>
        batch("apply", items),
      discardBatch: (items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[]) =>
        batch("discard", items),
      disposeDrafts: async (mode: "apply" | "discard", drafts: readonly DraftReviewSelection[]) =>
        (
          await runDraftBatch(
            drafts.map((draft) => ({ draft })),
            ({ draft }) => whole(mode, draft).outcome,
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
