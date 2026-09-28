/**
 * Renaming a Work from any of its titles (the band tab, the page heading).
 * The new name shows at once in every title through one shared pending name
 * per Work; a rejected rename restores the old name everywhere and reports the
 * failure to the title that was edited.
 */
import type { Work } from "@meridian/contracts/works";
import { useSyncExternalStore } from "react";
import { useWorkMutations } from "@/client/query/useWorks";

const pendingNames = new Map<string, string>();
const listeners = new Set<() => void>();

function setPendingName(workId: string, name: string | null) {
  if (name === null) pendingNames.delete(workId);
  else pendingNames.set(workId, name);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWorkRename(projectId: string, work: Work) {
  const update = useWorkMutations(projectId).update;
  const pending = useSyncExternalStore(
    subscribe,
    () => pendingNames.get(work.id) ?? null,
    () => null,
  );
  return {
    name: pending ?? work.name,
    rename: (name: string, onError: () => void) => {
      setPendingName(work.id, name);
      update.mutate(
        { workId: work.id, data: { name } },
        // Settles after the Work catalog has converged on the new name.
        { onSettled: () => setPendingName(work.id, null), onError },
      );
    },
  };
}
