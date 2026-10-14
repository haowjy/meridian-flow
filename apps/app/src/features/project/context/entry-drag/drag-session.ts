/**
 * The rows being dragged right now. A browser hides a drag's data until the
 * drop, so targets decide from this record instead. The drag carries only
 * Meridian's own type: a surface that can't take rows yet (the composer, the
 * editor) ignores the drop rather than pasting the names as stray text.
 */
import type { DragEvent } from "react";
import { MERIDIAN_ENTRIES_MIME } from "../tree-drop/drag-payload";
import { entrySystem, type SelectableEntry } from "./entry";

type EntryDrag = {
  entries: readonly SelectableEntry[];
  /**
   * The one system every row belongs to, or null: a selection that spans
   * systems, or holds a row without Move, moves nowhere (until Move or Copy
   * across systems exists) rather than silently dropping some rows.
   */
  system: string | null;
};

let active: EntryDrag | null = null;

export function activeEntryDrag(): EntryDrag | null {
  return active;
}

export function startEntryDrag(event: DragEvent, entries: readonly SelectableEntry[]) {
  const first = entries[0];
  if (!first) return;
  const system = entrySystem(first.scheme, first.owner);
  const one = entries.every(
    (entry) => entry.movable && entrySystem(entry.scheme, entry.owner) === system,
  );
  active = { entries, system: one ? system : null };
  const transfer = event.dataTransfer;
  transfer.effectAllowed = "copyMove";
  transfer.setData(MERIDIAN_ENTRIES_MIME, JSON.stringify(entries.map((entry) => entry.uri)));
  setPreview(transfer, entries);
  window.addEventListener("dragend", endEntryDrag, { once: true });
}

export function endEntryDrag() {
  active = null;
}

/** The chip under the pointer: the first row's name, and +N for the rest. */
function setPreview(transfer: DataTransfer, entries: readonly SelectableEntry[]) {
  const chip = document.createElement("div");
  chip.className =
    "pointer-events-none fixed -top-96 left-0 flex items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 py-1.5 text-sm text-popover-foreground shadow-sm";
  const name = document.createElement("span");
  name.textContent = entries[0]?.name ?? "";
  chip.append(name);
  if (entries.length > 1) {
    const count = document.createElement("span");
    count.className = "rounded-full bg-secondary px-1.5 text-xs text-secondary-foreground";
    count.textContent = `+${entries.length - 1}`;
    chip.append(count);
  }
  document.body.append(chip);
  transfer.setDragImage(chip, 12, 12);
  // The browser snapshots the element during dragstart; it is not needed after.
  requestAnimationFrame(() => chip.remove());
}
