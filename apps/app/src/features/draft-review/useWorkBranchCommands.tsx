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
import type { CapturedApply, CommandOutcome, DiscardNotice } from "./draft-command-owner";
import type { DraftReviewSelection } from "./draft-review-session";
import type { ChangeTarget } from "./review-model";

export type BranchCommandOutcome = CommandOutcome;
/** A surface's latest command feedback: a Discard with its Undo, or documents an Apply brought back. */
export type SurfaceNotice =
  | DiscardNotice
  | {
      kind: "applied";
      itemKey?: undefined;
      undo?: undefined;
      restored: string[];
      renamed: string[];
      end(): void;
      alsoApplied: string[];
    };
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
    /** The list without the item's move or delete, until the refetch confirms it. */
    const dropTreeLine = (item: ThreadDraftListItem) =>
      queryClient.setQueryData<ThreadDraftListItem[]>(
        projectQueryKeys.workBranchDrafts(projectId, workId),
        (rows) =>
          rows?.flatMap((row) =>
            row.itemKey !== item.itemKey ? [row] : row.hasDraft ? [{ ...row, tree: null }] : [],
          ),
      );
    const blocked = (): CommandStart => ({
      sent: false,
      outcome: Promise.resolve({ kind: "blocked" }),
    });
    const show = (value: SurfaceNotice) => {
      heldNotice.current = value;
      setNotice(value);
    };
    // Apply facts join the surface's notice until its next action.
    const applied = (
      item: ThreadDraftListItem | undefined,
      outcome: Extract<CommandOutcome, { kind: "done" }>,
    ) => {
      const held = heldNotice.current;
      const title = item?.documentName ?? documentBasename(item?.contextLocation?.path) ?? null;
      const restored = [
        ...(held?.kind === "applied" ? held.restored : []),
        ...(outcome.restored && title ? [title] : []),
      ];
      const renamed = [
        ...(held?.kind === "applied" ? held.renamed : []),
        ...(outcome.applied ?? []).flatMap(({ renamed: path }) => {
          if (!path) return [];
          const name = documentBasename(path);
          return name ? [name] : [];
        }),
      ];
      const alsoApplied = [
        ...(held?.kind === "applied" ? held.alsoApplied : []),
        ...(outcome.applied ?? []).flatMap((appliedItem) => {
          if (appliedItem.itemKey === item?.itemKey || !appliedItem.transition) return [];
          const from = documentBasename(appliedItem.transition.from);
          const to = documentBasename(appliedItem.transition.to);
          return from && to ? [`${from} → ${to}`] : [];
        }),
      ];
      if (restored.length || renamed.length || alsoApplied.length)
        show({ kind: "applied", restored, renamed, alsoApplied, end() {} });
    };
    // An archived Work's refusal is silent (`shownRefusal`): its notice explains it once this tab
    // has read the archive, which another tab or device may have made.
    type CapturedStart = {
      release(treeAlreadyApplied?: boolean): CommandStart;
      captured: CapturedApply;
      present(outcome: CommandOutcome): void;
    };
    const captureApply = (
      draft: DraftReviewSelection,
      target: ChangeTarget,
      restore?: boolean,
      resetNotice = true,
    ): CapturedStart | null => {
      if (resetNotice) endNotice();
      if (locked) return null;
      const rows =
        queryClient.getQueryData<ThreadDraftListItem[]>(
          projectQueryKeys.workBranchDrafts(projectId, workId),
        ) ?? [];
      const item = rows.find((candidate) => candidate.itemKey === draft.itemKey);
      const bringBack = restore ?? isDeletedFromManuscript(item);
      const tree = target.kind === "tree" || target.kind === "draft" || target.tree;
      const captured: CapturedApply | null = owner.captureApply(
        ref(draft),
        target,
        bringBack,
        (tree && item?.tree) || undefined,
      );
      if (!captured) return null;
      const present = (outcome: CommandOutcome) => {
        if (outcome.kind === "done" && tree && item?.tree) dropTreeLine(item);
        if (outcome.kind === "done") applied(item, outcome);
        if (outcome.kind === "needs-restore" || !owner.state(draft.itemKey).pending) refresh();
      };
      return {
        captured,
        present,
        release(treeAlreadyApplied = false) {
          if (treeAlreadyApplied && target.kind === "tree") {
            void captured.release({ cancel: true }).outcome;
            if (item) dropTreeLine(item);
            refresh();
            return { sent: false, outcome: Promise.resolve({ kind: "done" }) };
          }
          const started = captured.release({ omitTree: treeAlreadyApplied });
          void started.outcome.then(present);
          return started;
        },
      };
    };
    const start = (
      mode: "apply" | "discard",
      draft: DraftReviewSelection,
      target: ChangeTarget,
      restore?: boolean,
      treeAlreadyApplied = false,
      resetNotice = true,
    ): CommandStart => {
      const started =
        mode === "apply"
          ? (captureApply(draft, target, restore, resetNotice)?.release(treeAlreadyApplied) ??
            blocked())
          : dispatchDiscard(draft, target, resetNotice);
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
    const dispatchDiscard = (
      draft: DraftReviewSelection,
      target: ChangeTarget,
      resetNotice = true,
    ): CommandStart => {
      if (resetNotice) endNotice();
      if (locked) return blocked();
      const item = row(draft);
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
      // A move or delete is discarded on the server, with the item's chosen text, as one command.
      if (target.kind === "tree" || (item?.tree && (target.kind === "draft" || target.tree))) {
        if (!item?.tree) return blocked();
        // The line goes at once; the refetch after the answer restores it if the server refused.
        dropTreeLine(item);
        const outcome = owner.discardItem(ref(draft), item, target, surface).then((answer) => {
          refresh();
          return answer;
        });
        // No Undo: the server's settlement of the move or delete has none (`discardItem`).
        if (surface === "dock") show({ kind: "discarded", itemKey: draft.itemKey, end() {} });
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
        if (mode === "apply") {
          endNotice();
          const captured = items.map(({ draft, target }) => ({
            draft,
            command: captureApply(draft, target, restore.has(draft.documentId), false),
          }));
          const outcomes = owner.releaseBatch(
            captured.map(({ draft, command }) => ({
              itemKey: draft.itemKey,
              command: command?.captured ?? null,
            })),
          );
          void outcomes.then((settled) => {
            settled.forEach((outcome, index) => {
              captured[index]?.command?.present(outcome);
            });
          });
          return outcomes;
        }
        return Promise.all(items.map(({ draft, target }) => start(mode, draft, target).outcome));
      },
      disposeDrafts: (
        mode: "apply" | "discard",
        drafts: readonly DraftReviewSelection[],
        restore: ReadonlySet<string> = new Set(),
      ) => {
        if (mode === "apply") {
          endNotice();
          const captured = drafts.map((draft) => ({
            draft,
            command: captureApply(
              draft,
              { kind: "draft" as const },
              restore.has(draft.documentId),
              false,
            ),
          }));
          const outcomes = owner.releaseBatch(
            captured.map(({ draft, command }) => ({
              itemKey: draft.itemKey,
              command: command?.captured ?? null,
            })),
          );
          void outcomes.then((settled) => {
            settled.forEach((outcome, index) => {
              captured[index]?.command?.present(outcome);
            });
          });
          return outcomes;
        }
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
