/**
 * Shows the writer where an action placed rows (Move…, Copy to…, a drop): the sidebar brings up
 * the source whose tree holds the destination, that tree opens the folder and every folder above
 * it, and the rows are selected, taking focus as they arrive. The menu or drop that placed them
 * sits outside the destination's tree, which owns its own expansion and may not be mounted yet
 * (another tab, the foot's Scratch), so the request goes by the folder's id, and a tree that
 * mounts just after it still takes it.
 */
import type { EntryRef } from "./entry-drag/entry";
import { type EntrySelection, selectRows } from "./entry-drag/selection";

/** The folder rows were placed in, or the id of their source at its top. */
type Listener = (folderId: string) => void;

/** As long as the selection waits for arriving rows to take focus. */
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

/** Hears where rows are placed; a listener that subscribes just after a placement hears it too. */
export function subscribePlacedReveal(listener: Listener) {
  listeners.add(listener);
  if (latest && Date.now() - latest.at < FRESH_MS) listener(latest.folderId);
  return () => {
    listeners.delete(listener);
  };
}
