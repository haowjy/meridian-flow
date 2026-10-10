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

function entryIsExpanded(entries: TreeExpansion["entries"], entryId: string): boolean {
  return entries[entryId] ?? false;
}

export function useTreeExpansion(
  projectId: string,
  scope: string,
  folderIds: readonly string[] | null,
) {
  const accountId = useAccountId();
  const key = treeExpansionKey(accountId, projectId, scope);
  const [saved, setSaved] = useState(() => ({ key, state: readTreeExpansion(key, accountId) }));
  if (saved.key !== key) setSaved({ key, state: readTreeExpansion(key, accountId) });
  const update = useCallback(
    (change: (current: TreeExpansion) => TreeExpansion) => {
      setSaved((current) => {
        const state = change(
          current.key === key ? current.state : readTreeExpansion(key, accountId),
        );
        if (current.key === key && current.state === state) return current;
        writeTreeExpansion(key, accountId, state);
        return { key, state };
      });
    },
    [key, accountId],
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
  const isExpanded = useCallback(
    (entryId: string) => entryIsExpanded(saved.state.entries, entryId),
    [saved.state.entries],
  );
  const toggleEntry = useCallback(
    (entryId: string) =>
      update((current) => ({
        ...current,
        entries: {
          ...current.entries,
          [entryId]: !entryIsExpanded(current.entries, entryId),
        },
      })),
    [update],
  );
  return {
    isExpanded,
    toggleEntry,
    expanded: saved.state.expanded,
    expandedEntryIds: saved.state.entries,
    setExpanded,
    setExpandedEntryIds,
  };
}
