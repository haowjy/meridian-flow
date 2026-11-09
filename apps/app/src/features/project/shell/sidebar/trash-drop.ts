import type { DragEvent } from "react";
import { activeDragSession } from "../../context/entry-drag/drag-session";
import type { DragEntry } from "../../context/entry-drag/entry";

/** A drag of tree rows is over this element: let it drop here. */
export function acceptEntryDrag(event: DragEvent): boolean {
  if (!activeDragSession()) return false;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  return true;
}

/** The rows a drop onto Trash deletes, read before the drag session ends. */
export function draggedEntries(): readonly DragEntry[] {
  return activeDragSession()?.entries ?? [];
}
