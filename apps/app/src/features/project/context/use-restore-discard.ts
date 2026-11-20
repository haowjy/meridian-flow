/**
 * Restore of a press Discard from Trash: the press's Undo. Its progress is the account's one per
 * Discard (`DiscardRestores`), so every view showing it says the same thing.
 */
import { t } from "@lingui/core/macro";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useCommandDriver } from "@/client/commands/driver-context";
import { restorePressDiscard } from "@/client/query/press-commands";
import { notifyFailure } from "@/components/app/failure-toast";
import type { DiscardRestoreState } from "@/features/draft-review/discard-restores";
import { useDraftCommandOwner } from "./account-feature-context";

export type RestorableDiscard = { commandId: string; owner: string };

export function useRestoreDiscard(projectId: string) {
  const driver = useCommandDriver();
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
      const { answer } = await restores.restore(entry.commandId, async () =>
        driver
          ? restorePressDiscard(driver, {
              projectId,
              owner: entry.owner,
              pressCommandId: entry.commandId,
            })
          : { answer: "failed" },
      );
      if (answer === "failed")
        notifyFailure({
          key: `restore:${entry.commandId}`,
          title: t`Couldn't restore`,
          brief: true,
        });
    },
    [restores, driver, projectId],
  );
  return { states, restore };
}
