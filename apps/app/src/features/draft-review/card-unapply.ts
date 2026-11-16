import type { TurnAppliedCommand } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { unapplyCommand } from "@/client/api/branches-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { refreshTurnCards } from "@/client/query/useTurnLiveLineage";
import type { Unapplied } from "@/core/project-tree/tree-undo";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { unappliedOf } from "./draft-notices";

/**
 * A chat card's Undo of its applied changes: each Apply that took them, taken back whole, as
 * Ctrl+Z and the sidebar take it. An Apply this tab holds goes through its one owner
 * (`AppliedCommand`), so its editors and sidebar step follow; any other is sent by its id. Each
 * answer as `unappliedOf` reads it, or `failed` when one didn't reach the server.
 */
export function useCardUnapply(projectId: string | null) {
  const owner = useDraftCommandOwner();
  const queryClient = useQueryClient();
  return useCallback(
    async (applies: readonly TurnAppliedCommand[]): Promise<Unapplied | { taken: "failed" }> => {
      const answers = await Promise.all(
        applies.map(async (apply): Promise<Unapplied | { taken: "failed" }> => {
          // A band's Apply and the tree fact it handed the sidebar share an id: the later holds it.
          const held = [...owner.applied].findLast((one) => one.commandId === apply.commandId);
          if (held) return (await held.press(null)) ?? { taken: "already", treeLeft: [], held: [] };
          if (!projectId) return { taken: "failed" };
          try {
            const answer = await unapplyCommand(projectId, apply.branchId, {
              commandId: crypto.randomUUID(),
              applyCommandId: apply.commandId,
            });
            return answer.status === "unapplied" ? unappliedOf(answer) : { taken: "failed" };
          } catch {
            return { taken: "failed" };
          }
        }),
      );
      refreshTurnCards(queryClient);
      if (projectId)
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.ownerDraftsOf(projectId) });
      return joined(answers);
    },
    [owner, queryClient, projectId],
  );
}

/**
 * Several Un-Applies read as one press: what each took and left, together. One that didn't reach
 * the server makes the press a failure, which a retry sends again.
 */
function joined(
  answers: readonly (Unapplied | { taken: "failed" })[],
): Unapplied | { taken: "failed" } {
  const read = answers.filter((answer): answer is Unapplied => answer.taken !== "failed");
  if (read.length < answers.length) return { taken: "failed" };
  const took = read.some((answer) => answer.taken === "all" || answer.taken === "partly");
  const treeLeft = read.flatMap((answer) => answer.treeLeft);
  const held = read.flatMap((answer) => answer.held);
  const stayed = treeLeft.length > 0 || held.length > 0;
  return {
    taken: took ? (stayed ? "partly" : "all") : stayed ? "nothing" : "already",
    treeLeft,
    held,
  };
}
