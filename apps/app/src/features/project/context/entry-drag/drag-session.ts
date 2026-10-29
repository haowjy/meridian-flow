/**
 * The rows being dragged right now. A browser hides a drag's data until the drop, so the
 * session is the data: targets decide from it, and the drag itself carries only Meridian's own
 * type, empty, so a target can tell the drag apart from the types alone. Writing surfaces turn
 * resolvable rows into mentions, while every other surface ignores the drag rather than pasting
 * stray text.
 */
import { MERIDIAN_ENTRIES_MIME } from "../tree-drop/drag-payload";
import type { DragEntry, DragSource, EntryDrag } from "./entry";

let active: EntryDrag | null = null;

/** The drag with where it came from: the identities (for a writing surface), and the source (for a drop target deciding between moving at once and asking). */
export function activeDragSession(): EntryDrag | null {
  return active;
}

export function startEntryDrag(
  event: Pick<globalThis.DragEvent, "dataTransfer">,
  entries: readonly DragEntry[],
  source: DragSource,
) {
  const transfer = event.dataTransfer;
  if (!transfer || entries.length === 0) return;
  active = { entries, source };
  // An `<a>` carries its URL, and a drop on the window would navigate to it.
  transfer.clearData();
  transfer.effectAllowed = "copyMove";
  transfer.setData(MERIDIAN_ENTRIES_MIME, "");
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
