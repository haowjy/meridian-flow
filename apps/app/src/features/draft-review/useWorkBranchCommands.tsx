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
} from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { documentBasename } from "@/client/query/work-branch-files";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { isDeletedFromManuscript } from "./deleted-drafts";
import type { CommandOutcome, DiscardNotice } from "./draft-command-owner";
import type { DraftReviewSelection } from "./draft-review-session";
import type { ChangeTarget } from "./review-model";

export type BranchCommandOutcome = CommandOutcome;
/** A surface's latest command feedback: a Discard with its Undo, or documents an Apply brought back. */
export type SurfaceNotice =
  | DiscardNotice
  | { kind: "restored"; itemKey?: undefined; undo?: undefined; titles: string[]; end(): void };
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
  const queryClient = useQueryClient();
  const workId = work?.id ?? "";
  const locked = !work || isWorkArchived(work);
  const [notice, setNotice] = useState<SurfaceNotice | null>(null);
  const heldNotice = useRef<SurfaceNotice | null>(null);
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
    const show = (value: SurfaceNotice) => {
      heldNotice.current = value;
      setNotice(value);
    };
    // Each document an Apply brought back joins the notice until the surface's next action.
    const restored = (item: ThreadDraftListItem | undefined) => {
      const title = item?.documentName ?? documentBasename(item?.contextLocation?.path) ?? null;
      if (!title) return;
      const held = heldNotice.current;
      const titles = held?.kind === "restored" ? [...held.titles, title] : [title];
      show({ kind: "restored", titles, end() {} });
    };
    // An archived Work's refusal is silent (`shownRefusal`): its notice explains it once this tab
    // has read the archive, which another tab or device may have made.
    const start = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
      restore?: boolean,
    ): CommandStart => {
      const started = dispatch(mode, draft, target, restore);
      void started.outcome.then((outcome) => {
        if (outcome.kind === "change-refused" && outcome.code === "work_archived")
          void queryClient.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) });
      });
      return started;
    };
    /**
     * `restore` is whether the writer chose to bring a deleted document back (D79). A single
     * document's Apply means yes when its row showed it deleted; an Apply all passes what its
     * confirmation named.
     */
    const dispatch = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
      restore?: boolean,
    ): CommandStart => {
      endNotice();
      if (locked) return blocked();
      const item = row(draft);
      if (mode === "apply") {
        const started =
          item?.isNew && !item.hasDraft && target.kind === "draft"
            ? owner.reveal(ref(draft))
            : owner.apply(ref(draft), target, restore ?? isDeletedFromManuscript(item));
        void started.outcome.then((outcome) => {
          if (outcome.kind === "done" && outcome.restored) restored(item);
          // A needs-restore answer means the row is behind: refresh so it shows the delete.
          if (outcome.kind === "needs-restore" || !owner.state(draft.itemKey).pending) refresh();
        });
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
          ...discarded.notice,
          undo: discarded.notice.undo
            ? () => {
                const acknowledged = discarded.notice.undo?.() ?? Promise.resolve();
                if (item)
                  queryClient.setQueryData<ThreadDraftListItem[]>(
                    projectQueryKeys.workBranchDrafts(projectId, workId),
                    (rows) =>
                      rows?.some((row) => row.itemKey === item.itemKey)
                        ? rows
                        : [...(rows ?? []), item],
                  );
                return acknowledged.then(refresh, refresh);
              }
            : undefined,
        });
      void discarded.outcome.then(refresh);
      return { sent: true, outcome: discarded.outcome };
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
      /** `restore`: the documents an Apply all's confirmation named; it brings back no other. */
      batch: (
        mode: "apply" | "discard",
        items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
        restore: ReadonlySet<string> = new Set(),
      ) => {
        // Capture every item in the event turn, not in a promise continuation.
        const outcomes = items.map(
          ({ draft, target }) => start(mode, draft, target, restore.has(draft.documentId)).outcome,
        );
        return Promise.all(outcomes);
      },
      disposeDrafts: (
        mode: "apply" | "discard",
        drafts: readonly DraftReviewSelection[],
        restore: ReadonlySet<string> = new Set(),
      ) => {
        if (mode === "apply")
          return Promise.all(
            drafts.map(
              (draft) =>
                start(mode, draft, { kind: "draft" }, restore.has(draft.documentId)).outcome,
            ),
          );
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
  }, [owner, locked, projectId, workId, threadId, surface, queryClient, notice]);
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
