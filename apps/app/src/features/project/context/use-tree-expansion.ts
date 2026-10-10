/** React owner for a tree's tab-local disclosure state; unloaded catalogs never prune. */
import { type SetStateAction, useCallback, useEffect, useState } from "react";
import { useAccountId } from "./account-feature-context";
import {
  pruneTreeExpansion,
  readTreeExpansion,
  type TreeExpansion,
  treeExpansionKey,
  writeTreeExpansion,
} from "./tree-expansion-state";

export function useTreeExpansion(
  projectId: string,
  scope: string,
  folderIds: readonly string[] | null,
) {
  const accountId = useAccountId();
  const key = treeExpansionKey(accountId, projectId, scope);
  const [saved, setSaved] = useState(() => ({ key, state: readTreeExpansion(key) }));
  if (saved.key !== key) setSaved({ key, state: readTreeExpansion(key) });
  const update = useCallback(
    (change: (current: TreeExpansion) => TreeExpansion) => {
      setSaved((current) => {
        const state = change(current.key === key ? current.state : readTreeExpansion(key));
        if (current.key === key && current.state === state) return current;
        writeTreeExpansion(key, state);
        return { key, state };
      });
    },
    [key],
  );
  useEffect(() => {
    if (folderIds === null) return;
    update((current) => pruneTreeExpansion(current, folderIds));
  }, [folderIds, update]);
  const setExpanded = useCallback(
    (expanded: boolean) => update((current) => ({ ...current, expanded })),
    [update],
  );
  const setExpandedEntryIds = useCallback(
    (action: SetStateAction<Record<string, boolean>>) =>
      update((current) => ({
        ...current,
        entries: typeof action === "function" ? action(current.entries) : action,
      })),
    [update],
  );
  return {
    expanded: saved.state.expanded,
    expandedEntryIds: saved.state.entries,
    setExpanded,
    setExpandedEntryIds,
  };
}
