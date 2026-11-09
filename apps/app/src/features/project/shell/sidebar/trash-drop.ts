import type { DragEvent } from "react";
import { activeDragSession } from "../../context/entry-drag/drag-session";
import type { DragEntry } from "../../context/entry-drag/entry";

/** A drag of tree rows is over this element: let it drop here. Trash's own rows are already deleted. */
export function acceptEntryDrag(event: DragEvent): boolean {
  const drag = activeDragSession();
  if (!drag || drag.source === "trash") return false;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  return true;
}

/** The rows a drop onto Trash deletes, read before the drag session ends. */
export function draggedEntries(): readonly DragEntry[] {
  const drag = activeDragSession();
  return drag && drag.source !== "trash" ? drag.entries : [];
}
