/**
 * Each open document's pending changes by Work, as this tab's editor holds them. The server counts
 * the same thing (`textChanges`, by `pendingChanges`) and lists a Work's suggestion row exactly
 * while that count is above 0, but only once it derives the document, a debounce after each
 * write. The tab's own Apply, Discard, Undo and typing are in its editor first, so while the
 * document is open the rows on screen follow the editor: their counts, and whether they are listed.
 */
import type { DraftItem } from "@meridian/contracts/drafts";
import { useSyncExternalStore } from "react";

type Counts = ReadonlyMap<string, Readonly<Record<string, number>>>;

/** Each open editor's document and its changes by Work: two editors of one document both hold it. */
const editors = new Map<object, { documentId: string; byWork: Readonly<Record<string, number>> }>();
let counts: Counts = new Map();
const listeners = new Set<() => void>();

/**
 * The row the server last listed for a document while it was open here, by owner, and where: an
 * Undo of the document's last change, or a peer's resolution the server lists before it has the
 * writer's offline typing, lists it again there before the server does. Kept after the editor
 * closes: a host remounting offline would otherwise lose it, and a row is only listed from here
 * while an editor here holds changes of its owner.
 */
const seen = new Map<string, { row: DraftItem; index: number }>();
const seenKey = (owner: string, documentId: string) => `${owner}\n${documentId}`;

/** `editor`'s document's changes by Work; null when it closes. */
export function publishTabChangeCounts(
  editor: object,
  documentId: string,
  byWork: Readonly<Record<string, number>> | null,
): void {
  const was = editors.get(editor);
  if (byWork === null ? !was : was && sameCounts(was.byWork, byWork)) return;
  if (byWork === null) editors.delete(editor);
  else editors.set(editor, { documentId, byWork });
  const next = new Map<string, Readonly<Record<string, number>>>();
  for (const held of editors.values()) next.set(held.documentId, held.byWork);
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
/** Each open document's changes by Work, as this tab's editors hold them now. */
export const tabChangeCounts = (): Counts => counts;

export function useTabChangeCounts(): Counts {
  return useSyncExternalStore(subscribe, tabChangeCounts, tabChangeCounts);
}

/** A row the server lists for its suggestions alone: no tree change or whole item. */
const suggestionsOnly = (row: DraftItem) => row.textChanges > 0 && !row.wholeItem && !row.tree;

/** `owner`'s rows as this tab's open editors hold their documents. */
export function withTabChangeCounts(items: DraftItem[], owner: string, tab: Counts): DraftItem[] {
  if (tab.size === 0) return items;
  let changed = false;
  const next: DraftItem[] = [];
  items.forEach((row, index) => {
    const held = tab.get(row.documentId);
    if (!held || !suggestionsOnly(row)) {
      next.push(row);
      return;
    }
    seen.set(seenKey(owner, row.documentId), { row, index });
    const textChanges = held[owner] ?? 0;
    if (textChanges === row.textChanges) next.push(row);
    else {
      changed = true;
      if (textChanges > 0) next.push({ ...row, textChanges });
    }
  });
  for (const [documentId, held] of tab) {
    const textChanges = held[owner] ?? 0;
    const was = seen.get(seenKey(owner, documentId));
    if (!was || textChanges === 0 || items.some((row) => row.documentId === documentId)) continue;
    changed = true;
    next.splice(Math.min(was.index, next.length), 0, { ...was.row, textChanges });
  }
  return changed ? next : items;
}
