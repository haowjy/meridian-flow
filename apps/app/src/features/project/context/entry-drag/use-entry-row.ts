/** What a list row needs to be selectable and draggable. */
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { startEntryDrag } from "./drag-session";
import type { SelectableEntry } from "./entry";
import { useEntrySelection } from "./selection";

export function useEntryRow(entry: SelectableEntry, active: boolean) {
  const { scope, selected, rowProps } = useEntrySelection(entry, active);
  return {
    selected,
    rowProps: {
      ...rowProps,
      draggable: true,
      onDragStart: (event: DragEvent) => {
        event.stopPropagation();
        startEntryDrag(event, scope ? scope.dragged(entry) : [entry]);
      },
    },
    /** A selection gesture (Ctrl/Cmd or Shift) selects instead of opening or toggling. */
    activate:
      (open: () => void) =>
      (event: MouseEvent | KeyboardEvent): void => {
        if (scope?.click(entry, event)) return;
        open();
      },
  };
}
