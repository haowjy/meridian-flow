/**
 * The rows being dragged right now. A browser hides a drag's data until the
 * drop, so targets decide from this record instead. The drag carries only
 * Meridian's own type: writing surfaces turn resolvable rows into mentions,
 * while every other surface ignores it rather than pasting stray text.
 */
import type { DragEvent } from "react";
import { MERIDIAN_ENTRIES_MIME } from "../tree-drop/drag-payload";
import type { DragEntry, DragSource, EntryDrag } from "./entry";

let active: EntryDrag | null = null;

/** What a writing surface may turn into mentions: the dragged identities, whatever started the drag. */
export function activeEntryDrag(): readonly DragEntry[] | null {
  return active?.entries ?? null;
}

/** The drag with where it came from, for a drop target deciding between moving at once and asking. */
export function activeDragSession(): EntryDrag | null {
  return active;
}

export function startEntryDrag(
  event: DragEvent,
  entries: readonly DragEntry[],
  source: DragSource,
) {
  if (entries.length === 0) return;
  active = { entries, source };
  const transfer = event.dataTransfer;
  // An `<a>` carries its URL, and a drop on the window would navigate to it.
  transfer.clearData();
  transfer.effectAllowed = "copyMove";
  transfer.setData(MERIDIAN_ENTRIES_MIME, JSON.stringify(entries.map((entry) => entry.uri)));
  setPreview(transfer, entries);
  window.addEventListener("dragend", endEntryDrag, { once: true });
}

function endEntryDrag() {
  active = null;
}

/** The chip under the pointer: the first row's name, and +N for the rest. */
function setPreview(transfer: DataTransfer, entries: readonly DragEntry[]) {
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
