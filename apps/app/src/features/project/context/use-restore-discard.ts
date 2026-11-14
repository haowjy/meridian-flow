/**
 * Restore of a Discard from Trash or from the draft it closed, with its progress shared by every
 * place that shows the entry: the mutation cache holds one restore per Discard, so Trash's row and
 * an editor showing the draft read the same answer.
 */
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { RestoreReturned } from "@/features/draft-review/draft-notices";
import { restoreDiscard } from "@/features/draft-review/useWorkBranchCommands";

export type RestorableDiscard = {
  commandId: string;
  branchId: string;
  documentIds: readonly string[];
};

/** Where one Discard's restore stands here; none until it is pressed. */
export type DiscardRestoreState =
  | { kind: "restoring" }
  | { kind: "restored" }
  | { kind: "returned"; why: RestoreReturned }
  | { kind: "failed" };

const restoreKey = (projectId: string) => ["restore-discard", projectId] as const;

export function useRestoreDiscard(projectId: string) {
  const queryClient = useQueryClient();
  const { mutate } = useMutation({
    mutationKey: restoreKey(projectId),
    mutationFn: (entry: RestorableDiscard) =>
      restoreDiscard(queryClient, {
        projectId,
        branchId: entry.branchId,
        discardCommandId: entry.commandId,
        documentIds: entry.documentIds,
      }),
  });
  const runs = useMutationState({
    filters: { mutationKey: restoreKey(projectId) },
    select: (mutation) => ({
      commandId: (mutation.state.variables as RestorableDiscard | undefined)?.commandId,
      status: mutation.state.status,
      answer: mutation.state.data as Awaited<ReturnType<typeof restoreDiscard>> | undefined,
    }),
  });
  // The cache lists runs oldest first: the last one per Discard is where it stands.
  const states = useMemo(() => {
    const byCommand = new Map<string, DiscardRestoreState>();
    for (const run of runs) {
      if (!run.commandId) continue;
      const { answer } = run;
      byCommand.set(
        run.commandId,
        run.status === "pending"
          ? { kind: "restoring" }
          : answer?.answer === "ok" || answer?.answer === "gone"
            ? { kind: "restored" }
            : answer?.answer === "returned" && answer.why
              ? { kind: "returned", why: answer.why }
              : { kind: "failed" },
      );
    }
    return byCommand as ReadonlyMap<string, DiscardRestoreState>;
  }, [runs]);
  const restore = useCallback(
    (entry: RestorableDiscard) => {
      if (states.get(entry.commandId)?.kind === "restoring") return;
      mutate(entry);
    },
    [mutate, states],
  );
  return { states, restore };
}
