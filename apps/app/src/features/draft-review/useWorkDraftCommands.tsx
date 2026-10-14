/** Creation-bound Work commands, independent of an open review. Navigation remains an explicit UI effect. */
import type { Work } from "@meridian/contracts/works";
import { isWorkArchived } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  type ChatApplyPlan,
  type DraftCommandOutcome,
  discardDraftItem,
  type PreparedApply,
  runWorkWideCommand,
  applyChanges as sendApplyChanges,
  applyChatChanges as sendApplyChatChanges,
  applyDraft as sendApplyDraft,
} from "@/client/query/draft-command-executor";
import type { ChangeTarget, DraftRef } from "@/client/query/draft-command-record";
import { getContextTabs, matchesReviewItem } from "@/client/stores";
import { useLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";
import { routeTargetForTab } from "@/features/project/context/context-removal-planner";
import {
  useIsCurrentContextRoute,
  useOpenContextRoute,
} from "@/features/project/routing/ProjectNavigationContext";
import { useDraftOnlyLifecycle } from "./draft-only-lifecycle";
import type { DraftReviewSelection } from "./draft-review-session";
import { acquireItemSnapshot } from "./useDraftApply";

export type WorkDraftCommands = ReturnType<typeof useWorkDraftCommands>;

/** How an Apply gets its snapshot: from the frame the writer clicked. */
export type PrepareApply = () => Promise<PreparedApply>;

export type CommandStart = { sent: boolean; outcome: Promise<DraftCommandOutcome> };

const BLOCKED: DraftCommandOutcome = { kind: "blocked" };

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
  const registry = useLiveDocumentSessionRegistry();
  const lifecycle = useDraftOnlyLifecycle(projectId);
  const openContextRoute = useOpenContextRoute();
  const isCurrentContextRoute = useIsCurrentContextRoute();
  const frozen = !work || isWorkArchived(work);
  const commands = useMemo(() => {
    const scope = { projectId, workId };
    const refOf = (draft: DraftReviewSelection): DraftRef => ({
      ...scope,
      documentId: draft.documentId,
      itemKey: draft.itemKey,
    });

    /**
     * The item's own command outcome is the only promote or remove signal (contract §3.4): an Apply that
     * dropped a created item's row turns its tab live, an item Discard closes it, and every other outcome
     * leaves the tab alone. A list or a metadata read never reaches this.
     */
    const settleTab = (draft: DraftReviewSelection, outcome: DraftCommandOutcome) => {
      const target = refOf(draft);
      if (outcome.kind === "discarded") {
        try {
          lifecycle.remove(target);
        } catch {
          /* The committed command must not be resent for route repair. */
        }
        return;
      }
      if (outcome.kind !== "applied" || !outcome.itemClosed) return;
      const tab = getContextTabs(projectId).tabs.find((candidate) =>
        matchesReviewItem(candidate, { reviewWorkId: workId, reviewItemKey: draft.itemKey }),
      );
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
    const settled = (draft: DraftReviewSelection, outcome: Promise<DraftCommandOutcome>) =>
      outcome.then((result) => {
        settleTab(draft, result);
        return result;
      });

    const applyChanges = (
      draft: DraftReviewSelection,
      targets: readonly ChangeTarget[],
      baseKey: string,
      prepare: PrepareApply,
    ): Promise<DraftCommandOutcome> =>
      frozen
        ? Promise.resolve(BLOCKED)
        : settled(
            draft,
            sendApplyChanges(
              queryClient,
              { scope: "change", draft: refOf(draft), targets, baseKey, prepare },
              threadId,
            ),
          );

    /** Apply the changes of one chat in an item nobody has open: the room is read inside the command. */
    const applyChatChanges = (
      draft: DraftReviewSelection,
      acquire: () => Promise<ChatApplyPlan | null>,
    ): Promise<DraftCommandOutcome> =>
      frozen
        ? Promise.resolve(BLOCKED)
        : settled(draft, sendApplyChatChanges(queryClient, refOf(draft), acquire, threadId));

    /**
     * Apply a whole item. With no `prepare`, the item is one nobody has open: its room is read inside the
     * command, for as long as the command lasts, under the claim taken at the click.
     */
    const applyDraft = (draft: DraftReviewSelection, prepare?: PrepareApply): CommandStart => {
      if (frozen) return { sent: false, outcome: Promise.resolve(BLOCKED) };
      return {
        sent: true,
        outcome: settled(
          draft,
          sendApplyDraft(
            queryClient,
            {
              scope: "item",
              draft: refOf(draft),
              prepare: prepare ?? (() => acquireItemSnapshot(registry, queryClient, refOf(draft))),
            },
            threadId,
          ),
        ),
      };
    };

    /** Item Discard: closes the item on the server. A review's own Discard draft is a local edit instead. */
    const discardDraft = (draft: DraftReviewSelection): CommandStart => {
      if (frozen) return { sent: false, outcome: Promise.resolve(BLOCKED) };
      return {
        sent: true,
        outcome: settled(draft, discardDraftItem(queryClient, refOf(draft), threadId)),
      };
    };

    /** The Work page's Apply all and Discard all: one command over the Work's draft. */
    const disposeDrafts = async (
      mode: "apply" | "discard",
      drafts: readonly DraftReviewSelection[],
    ): Promise<DraftCommandOutcome[]> => {
      if (frozen) return drafts.map(() => BLOCKED);
      const outcomes = await runWorkWideCommand(queryClient, scope, mode, drafts, threadId);
      for (const [index, outcome] of outcomes.entries()) settleTab(drafts[index], outcome);
      return outcomes;
    };

    return {
      projectId,
      workId,
      threadId,
      applyChanges,
      applyChatChanges,
      applyDraft,
      discardDraft,
      disposeDrafts,
    };
  }, [
    projectId,
    workId,
    threadId,
    frozen,
    queryClient,
    registry,
    lifecycle,
    openContextRoute,
    isCurrentContextRoute,
  ]);
  return { ...commands, dispositionLocked: frozen, changesLocked: frozen };
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
