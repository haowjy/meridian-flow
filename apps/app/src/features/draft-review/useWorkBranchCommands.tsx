/** Work-scoped authority over the account command owner; notices belong to the surface that made them. */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import type { CommandOutcome, DiscardNotice } from "./draft-command-owner";
import type { DraftReviewSelection } from "./draft-review-session";
import type { ChangeTarget } from "./review-model";

export type BranchCommandOutcome = CommandOutcome;
export type CommandStart = { sent: boolean; outcome: Promise<CommandOutcome> };
export type WorkBranchCommands = ReturnType<typeof useWorkBranchCommands>;

export function useWorkBranchCommands({
  projectId,
  work,
  threadId = null,
  surface = "dock",
}: {
  projectId: string;
  work: Work | null;
  threadId?: string | null;
  surface?: "editor" | "dock";
}) {
  const owner = useDraftCommandOwner();
  useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  const queryClient = useQueryClient();
  const workId = work?.id ?? "";
  const locked = !work || isWorkArchived(work);
  const [notice, setNotice] = useState<DiscardNotice | null>(null);
  const heldNotice = useRef<DiscardNotice | null>(null);
  const endNotice = () => {
    heldNotice.current?.end();
    heldNotice.current = null;
    setNotice(null);
  };
  useEffect(
    () => () => {
      heldNotice.current?.end();
      heldNotice.current = null;
      setNotice(null);
    },
    [owner, projectId, workId, threadId],
  );
  useEffect(() => {
    if (notice?.itemKey && owner.state(notice.itemKey).closed) endNotice();
  }, [notice, owner, owner.snapshot()]);
  return useMemo(() => {
    const ref = (draft: DraftReviewSelection) => ({ projectId, workId, ...draft });
    const row = (draft: DraftReviewSelection) =>
      queryClient
        .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workBranchDrafts(projectId, workId))
        ?.find((item) => item.itemKey === draft.itemKey);
    const refresh = () => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workBranchDrafts(projectId, workId),
      });
    };
    const blocked = (): CommandStart => ({
      sent: false,
      outcome: Promise.resolve({ kind: "blocked" }),
    });
    const show = (value: DiscardNotice) => {
      heldNotice.current = value;
      setNotice(value);
    };
    const start = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
    ): CommandStart => {
      endNotice();
      if (locked) return blocked();
      const item = row(draft);
      if (mode === "apply") {
        const started =
          item?.isNew && !item.hasDraft && target.kind === "draft"
            ? owner.reveal(ref(draft))
            : owner.apply(ref(draft), target);
        void started.outcome.then(refresh);
        return started;
      }
      if (item?.isNew && target.kind === "draft") {
        const removed: DiscardNotice = { kind: "removed", end() {} };
        const outcome = owner.removeCreated(ref(draft), item).then((answer) => {
          refresh();
          if (answer.kind !== "done") {
            if (heldNotice.current === removed) endNotice();
            void queryClient.invalidateQueries({
              queryKey: projectQueryKeys.workDraftMetadata(
                projectId,
                workId,
                draft.documentId,
                draft.itemKey,
              ),
            });
          }
          return answer;
        });
        show(removed);
        return { sent: true, outcome };
      }
      const discarded = owner.discard(ref(draft), target, surface, endNotice);
      if (!discarded) return blocked();
      if (surface === "dock")
        show({
          ...discarded,
          undo: discarded.undo
            ? () => {
                discarded.undo?.();
                if (item)
                  queryClient.setQueryData<ThreadDraftListItem[]>(
                    projectQueryKeys.workBranchDrafts(projectId, workId),
                    (rows) =>
                      rows?.some((row) => row.itemKey === item.itemKey)
                        ? rows
                        : [...(rows ?? []), item],
                  );
                void owner.acknowledged(draft.itemKey).then(refresh, refresh);
              }
            : undefined,
        });
      refresh();
      return { sent: true, outcome: Promise.resolve({ kind: "done" }) };
    };
    const commandChange = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
    ) => start(mode, draft, target).outcome;
    const startDraft = (mode: "apply" | "discard", draft: DraftReviewSelection) =>
      start(mode, draft, { kind: "draft" });
    return {
      projectId,
      workId,
      threadId,
      owner,
      notice,
      dismissNotice: endNotice,
      undoNotice: () => {
        heldNotice.current?.undo?.();
        endNotice();
      },
      dispositionLocked: locked,
      changesLocked: locked,
      commandChange,
      startDraft,
      apply: (documentId: string, itemKey: string) =>
        startDraft("apply", { documentId, itemKey }).outcome,
      discard: (documentId: string, itemKey: string) =>
        startDraft("discard", { documentId, itemKey }).outcome,
      batch: (
        mode: "apply" | "discard",
        items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
      ) => {
        // Capture every item in the event turn, not in a promise continuation.
        const outcomes = items.map(({ draft, target }) => start(mode, draft, target).outcome);
        return Promise.all(outcomes);
      },
      disposeDrafts: (mode: "apply" | "discard", drafts: readonly DraftReviewSelection[]) => {
        if (mode === "apply")
          return Promise.all(drafts.map((draft) => startDraft(mode, draft).outcome));
        endNotice();
        const branchId = drafts.map(row).find(Boolean)?.branchId;
        if (locked || !branchId)
          return Promise.resolve(drafts.map(() => ({ kind: "blocked" as const })));
        return owner.discardAll(drafts.map(ref), branchId).then((answer) => {
          refresh();
          return drafts.map(() => answer);
        });
      },
    };
  }, [owner, owner.snapshot(), locked, projectId, workId, threadId, surface, queryClient, notice]);
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
