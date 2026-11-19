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
  commandId: string;
  branchId: string;
  documentIds: readonly string[];
};

export function useRestoreDiscard(projectId: string) {
  const queryClient = useQueryClient();
  const { restores } = useDraftCommandOwner();
  const revision = useSyncExternalStore(restores.subscribe, restores.snapshot, restores.snapshot);
  const states = useMemo(
    () => ({
      get: (commandId: string): DiscardRestoreState | undefined => restores.state(commandId),
    }),
    // A new revision is a new reader, so every view showing a restore renders its answer.
    [restores, revision],
  );
  const restore = useCallback(
    async (entry: RestorableDiscard) => {
      await restores.restore(entry.commandId, () =>
        restoreDiscard(queryClient, {
          projectId,
          branchId: entry.branchId,
          discardCommandId: entry.commandId,
          documentIds: entry.documentIds,
        }),
      );
    },
    [restores, queryClient, projectId],
  );
  return { states, restore };
}
