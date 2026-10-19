/** Review command surface until B2 installs the per-draft command owner. */
import type { Work } from "@meridian/contracts/works";
import { isWorkArchived } from "@meridian/contracts/works";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { DraftReviewSelection } from "./draft-review-session";
import type { ChangeTarget } from "./review-changes";

export type BranchCommandOutcome = { kind: "blocked" } | { kind: "change-refused"; code: string };
export type CommandStart = { sent: false; outcome: Promise<BranchCommandOutcome> };
export type DraftSelection = { selection: readonly string[] };
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
  const locked = !work || isWorkArchived(work);
  return useMemo(() => {
    const inert = async (): Promise<BranchCommandOutcome> => {
      // B2: command owner
      return { kind: "blocked" };
    };
    const start = (): CommandStart => ({ sent: false, outcome: inert() });
    return {
      projectId,
      workId,
      threadId,
      dispositionLocked: locked,
      changesLocked: locked,
      commandChange: async (
        _mode: "apply" | "discard",
        _draft: DraftReviewSelection,
        _target: ChangeTarget,
      ) => inert(),
      startDraft: (_mode: "apply" | "discard", _draft: DraftReviewSelection) => start(),
      apply: (_documentId: string, _itemKey: string) => inert(),
      discard: (_documentId: string, _itemKey: string) => inert(),
      applyChanges: (_draft: DraftReviewSelection, _changes: readonly string[]) => inert(),
      discardChanges: (_draft: DraftReviewSelection, _changes: readonly string[]) => inert(),
      applyBatch: async (
        _items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
      ) => [],
      discardBatch: async (
        _items: readonly { draft: DraftReviewSelection; target: ChangeTarget }[],
      ) => [],
      disposeDrafts: async (_mode: "apply" | "discard", drafts: readonly DraftReviewSelection[]) =>
        drafts.map(() => ({ kind: "blocked" as const })),
    };
  }, [locked, projectId, threadId, workId]);
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
