/**
 * Restore of a Discard from Trash. Its progress is the account's one
 * per Discard (`DiscardRestores`), which the Discard's notice reads too, so Trash's row, an editor
 * showing the draft and the notice say the same thing.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { DiscardRestoreState } from "@/features/draft-review/discard-restores";
import { restoreDiscard } from "@/features/draft-review/useWorkBranchCommands";
import { useDraftCommandOwner } from "./account-feature-context";

export type RestorableDiscard = {
  /** The run's Discards, latest first: each is restored in turn. */
  commandIds: readonly string[];
  branchId: string;
  documentIds: readonly string[];
};

/** A run's restore as one: restoring while any is, and restored once every one is. */
function runState(
  states: readonly (DiscardRestoreState | undefined)[],
): DiscardRestoreState | undefined {
  const held = states.filter((state): state is DiscardRestoreState => state !== undefined);
  if (held.length === 0) return undefined;
  const find = <K extends DiscardRestoreState["kind"]>(kind: K) =>
    held.find((state): state is Extract<DiscardRestoreState, { kind: K }> => state.kind === kind);
  const failed = find("failed");
  if (failed) return failed;
  const returned = find("returned");
  if (returned) return returned;
  if (held.length < states.length || find("restoring")) return { kind: "restoring" };
  const restored = held.flatMap((state) => (state.kind === "restored" ? [state] : []));
  if (restored.length === 0) return held[0];
  const branchId = restored.find((state) => state.branchId)?.branchId;
  return {
    kind: "restored",
    ...(branchId ? { branchId } : {}),
    leftOut: restored.reduce((sum, state) => sum + state.leftOut, 0),
    brought: {
      text: [...new Set(restored.flatMap((state) => state.brought.text))],
      tree: [...new Set(restored.flatMap((state) => state.brought.tree))],
    },
  };
}

export function useRestoreDiscard(projectId: string) {
  const queryClient = useQueryClient();
  const { restores } = useDraftCommandOwner();
  const revision = useSyncExternalStore(restores.subscribe, restores.snapshot, restores.snapshot);
  const states = useMemo(
    () => ({
      get: (commandId: string): DiscardRestoreState | undefined => restores.state(commandId),
      /** One state for a run of Discards. */
      of: (commandIds: readonly string[]): DiscardRestoreState | undefined =>
        runState(commandIds.map((commandId) => restores.state(commandId))),
    }),
    // A new revision is a new reader, so every view showing a restore renders its answer.
    [restores, revision],
  );
  const restore = useCallback(
    async (entry: RestorableDiscard) => {
      for (const discardCommandId of entry.commandIds)
        await restores.restore(discardCommandId, () =>
          restoreDiscard(queryClient, {
            projectId,
            branchId: entry.branchId,
            discardCommandId,
            documentIds: entry.documentIds,
          }),
        );
    },
    [restores, queryClient, projectId],
  );
  return { states, restore };
}
