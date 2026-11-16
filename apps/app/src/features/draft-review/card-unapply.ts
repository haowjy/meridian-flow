import type { TurnAppliedCommand } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { unapplyCommand } from "@/client/api/branches-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { refreshTurnCards } from "@/client/query/useTurnLiveLineage";
import type { TreeFact, Unapplied } from "@/core/project-tree/tree-undo";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { useClosedOwners } from "@/features/project/context/closed-owners";
import { type Answer, AppliedCommand, serverPort } from "./apply-history";

/**
 * A chat card's Undo of its applied changes: each Apply that took them, taken back whole, as
 * Ctrl+Z and the sidebar take it, through its one owner (`AppliedCommand`). An Apply this tab
 * doesn't hold yet (made in another tab, or before a reload) gets an owner of its own here, with
 * no editor or sidebar step, so every card listing it reads what became of it; `facts` is what
 * the card's tree lines say each change did. Resolves once the cards have read the server again,
 * with each answer joined.
 */
export function useCardUnapply(projectId: string | null) {
  const owner = useDraftCommandOwner();
  const queryClient = useQueryClient();
  const closed = useClosedOwners(projectId ?? "");
  return useCallback(
    async (
      applies: readonly TurnAppliedCommand[],
      facts: ReadonlyMap<string, TreeFact>,
    ): Promise<Answer> => {
      if (!projectId) return { taken: "failed" };
      const commandOf = (apply: TurnAppliedCommand) => {
        const held = owner.applied.find(apply.commandId);
        if (held) return held;
        const made: AppliedCommand = new AppliedCommand(
          { text: true, tree: null, sources: [], name: "", nodes: [...facts.keys()], facts },
          serverPort({
            commandId: apply.commandId,
            unapply: (body) => unapplyCommand(projectId, apply.branchId, body),
          }),
          () => [],
          { closed, seat: null, over: () => owner.applied.delete(made) },
        );
        owner.applied.add(made);
        return made;
      };
      const answers = await Promise.all(applies.map((apply) => commandOf(apply).press(null)));
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.ownerDraftsOf(projectId) });
      await refreshTurnCards(queryClient);
      return joined(answers);
    },
    [owner, queryClient, projectId, closed],
  );
}

/**
 * Several Un-Applies read as one press: what each took and left, together. One that didn't reach
 * the server makes the press a failure, which a retry sends again.
 */
function joined(answers: readonly Answer[]): Answer {
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
