/** What a list row needs to be selectable and draggable. */
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { startEntryDrag } from "./drag-session";
import type { DragEntry } from "./entry";
import { useEntrySelectionRow } from "./selection";

export function useEntryRow(entry: DragEntry, active: boolean) {
  const { selection, selected, rowProps } = useEntrySelectionRow(entry, active);
  return {
    selected,
    rowProps: {
      ...rowProps,
      draggable: Boolean(selection?.draggable && entry.movable),
      onDragStart: (event: DragEvent) => {
        event.stopPropagation();
        startEntryDrag(event, selection ? selection.dragged(entry) : [entry]);
      },
    },
    /** A selection gesture (Ctrl/Cmd or Shift) selects instead of opening or toggling. */
    activate:
      (open: () => void) =>
      (event: MouseEvent | KeyboardEvent): void => {
        if (selection?.click(entry, event)) return;
        open();
      },
  };
}
