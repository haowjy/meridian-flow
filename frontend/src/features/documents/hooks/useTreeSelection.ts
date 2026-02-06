import { useMemo } from "react";
import { useTreeStore } from "@/core/stores/useTreeStore";

/**
 * Abstracts selection logic from store implementation.
 * Components depend on this hook, not directly on store.
 * Makes testing easier and follows Dependency Inversion Principle.
 *
 * Performance: Subscribes only to `selectedIds` to avoid re-renders when
 * other store state (tree, documents, folders, etc.) changes.
 * Actions are retrieved via getState() since they don't change.
 *
 * @example
 * const { toggleSelection, clearSelection, isSelected } = useTreeSelection()
 *
 * // Cmd+Click to toggle selection
 * onClick={(e) => {
 *   if (e.metaKey || e.ctrlKey) {
 *     toggleSelection(id)
 *   }
 * }}
 */
export function useTreeSelection() {
  // Subscribe only to selectedIds for performance
  const selectedIds = useTreeStore((s) => s.selectedIds);

  // Get stable action references via getState() (they never change)
  const { toggleSelection, selectAll, clearSelection } =
    useTreeStore.getState();

  // Memoize isSelected to avoid creating new function references on every render
  const isSelected = useMemo(
    () => (id: string) => selectedIds.has(id),
    [selectedIds],
  );

  return {
    selectedIds,
    toggleSelection,
    selectAll,
    clearSelection,
    isSelected,
  };
}
