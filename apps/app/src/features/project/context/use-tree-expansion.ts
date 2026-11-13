/** React owner for a tree's tab-local disclosure state; unloaded catalogs never prune. */
import { type SetStateAction, useCallback, useEffect, useSyncExternalStore } from "react";
import type { SectionFold } from "@/components/ui/list-section";
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

// One owner per stored key: a tree can show on several surfaces at once (a chat's Scratch in the
// sidebar and in its Files menu), and every one of them must show and change the same state.
const states = new Map<string, TreeExpansion>();
const listeners = new Map<string, Set<() => void>>();

function storedState(key: string, accountId: string): TreeExpansion {
  let state = states.get(key);
  if (!state) {
    state = readTreeExpansion(key, accountId);
    states.set(key, state);
  }
  return state;
}

function changeState(
  key: string,
  accountId: string,
  change: (current: TreeExpansion) => TreeExpansion,
) {
  const current = storedState(key, accountId);
  const next = change(current);
  if (next === current) return;
  states.set(key, next);
  writeTreeExpansion(key, accountId, next);
  for (const listener of listeners.get(key) ?? []) listener();
}

export function useTreeExpansion(
  projectId: string,
  scope: string,
  folderIds: readonly string[] | null,
) {
  const accountId = useAccountId();
  const key = treeExpansionKey(accountId, projectId, scope);
  const subscribe = useCallback(
    (listener: () => void) => {
      const keyListeners = listeners.get(key) ?? new Set();
      listeners.set(key, keyListeners);
      keyListeners.add(listener);
      return () => keyListeners.delete(listener);
    },
    [key],
  );
  const state = useSyncExternalStore(subscribe, () => storedState(key, accountId));
  const update = useCallback(
    (change: (current: TreeExpansion) => TreeExpansion) => changeState(key, accountId, change),
    [key, accountId],
  );
  useEffect(() => {
    if (folderIds === null) return;
    update((current) => pruneTreeExpansion(current, folderIds));
  }, [folderIds, update]);
  const setExpandedEntryIds = useCallback(
    (action: SetStateAction<Record<string, boolean>>) =>
      update((current) => ({
        ...current,
        entries: typeof action === "function" ? action(current.entries) : action,
      })),
    [update],
  );
  const isExpanded = useCallback(
    (entryId: string) => entryIsExpanded(state.entries, entryId),
    [state.entries],
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
    expandedEntryIds: state.entries,
    setExpandedEntryIds,
  };
}

/** A list section's fold, kept like a tree folder's: per tab, in the trees' store. */
export function useSectionFold(
  projectId: string,
  scope: string,
  sectionId: string,
  defaultOpen = true,
): SectionFold {
  const { expandedEntryIds, setExpandedEntryIds } = useTreeExpansion(projectId, scope, null);
  return {
    open: expandedEntryIds[sectionId] ?? defaultOpen,
    onToggle: (open) => setExpandedEntryIds((entries) => ({ ...entries, [sectionId]: open })),
  };
}
