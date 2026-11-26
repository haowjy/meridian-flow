import type { EntryRef } from "./entry-drag/entry";
import { type EntrySelection, selectRows } from "./entry-drag/selection";

type Listener = (folderId: string) => void;

const FRESH_MS = 2000;

const listeners = new Set<Listener>();
let latest: { folderId: string; at: number } | null = null;

export function revealPlaced(
  folderId: string,
  rows: readonly EntryRef[],
  selection: EntrySelection | null,
) {
  latest = { folderId, at: Date.now() };
  for (const listener of listeners) listener(folderId);
  selectRows(selection, rows);
}

export function subscribePlacedReveal(listener: Listener) {
  listeners.add(listener);
  if (latest && Date.now() - latest.at < FRESH_MS) listener(latest.folderId);
  return () => {
    listeners.delete(listener);
  };
}
