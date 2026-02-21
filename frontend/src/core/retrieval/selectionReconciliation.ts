interface ReconcileSelectionArgs<TItem> {
  items: TItem[];
  activeId: string | null;
  getId: (item: TItem) => string;
  clearSelection: () => void;
  onStaleSelection?: (activeId: string) => void;
}

/**
 * Clears a persisted active selection when it no longer exists in the
 * authoritative loaded collection.
 */
export function reconcileSelectionIfMissing<TItem>({
  items,
  activeId,
  getId,
  clearSelection,
  onStaleSelection,
}: ReconcileSelectionArgs<TItem>): boolean {
  if (!activeId) return false;

  const exists = items.some((item) => getId(item) === activeId);
  if (exists) return false;

  onStaleSelection?.(activeId);
  clearSelection();
  return true;
}
