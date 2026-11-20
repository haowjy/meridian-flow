/**
 * Each open document's pending changes by Work, as this tab's editor holds them. The server counts
 * the same thing (`textChanges`, by `pendingChanges`), but only once it derives the document, a
 * debounce after each write; the tab's own Apply, Discard, Undo and typing are in its editor first,
 * so the counts on screen read them from here while the document is open.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { useSyncExternalStore } from "react";

type Counts = ReadonlyMap<string, Readonly<Record<string, number>>>;

let counts: Counts = new Map();
const listeners = new Set<() => void>();

/** `documentId`'s changes by Work as its open editor holds them; null when it closes. */
export function publishTabChangeCounts(
  documentId: string,
  byWork: Readonly<Record<string, number>> | null,
): void {
  const was = counts.get(documentId);
  if (byWork === null ? !was : was && sameCounts(was, byWork)) return;
  const next = new Map(counts);
  if (byWork === null) next.delete(documentId);
  else next.set(documentId, byWork);
  counts = next;
  for (const listener of listeners) listener();
}

function sameCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const snapshot = () => counts;

export function useTabChangeCounts(): Counts {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** `owner`'s rows with the text changes this tab's open editors hold. */
export function withTabChangeCounts(
  items: ThreadDraftListItem[],
  owner: string,
  tab: Counts,
): ThreadDraftListItem[] {
  if (tab.size === 0) return items;
  let changed = false;
  const next = items.map((row) => {
    const held = tab.get(row.documentId);
    if (!held || !row.hasDraft || row.wholeItem) return row;
    const textChanges = held[owner] ?? 0;
    if (textChanges === row.textChanges) return row;
    changed = true;
    return { ...row, textChanges };
  });
  return changed ? next : items;
}
