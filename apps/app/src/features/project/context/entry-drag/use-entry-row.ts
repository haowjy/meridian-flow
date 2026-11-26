/** What a list row needs to be selectable and draggable. */
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { startEntryDrag } from "./drag-session";
import type { DragEntry, DragSource } from "./entry";
import { useEntrySelectionRow } from "./selection";

export function useEntryRow(
  entry: DragEntry,
  {
    active,
    draggable = true,
    source = "list-row",
  }: {
    active: boolean;
    /** False for a row that names nothing a drag could act on (a navigation-only folder). */
    draggable?: boolean;
    source?: DragSource;
  },
) {
  const { selection, selected, rowProps } = useEntrySelectionRow(entry, active);
  return {
    selected,
    /** Spread on the row's control. */
    rowProps: {
      ...rowProps,
      draggable: Boolean(selection?.draggable && draggable),
      onDragStart: (event: DragEvent) => {
        event.stopPropagation();
        startEntryDrag(event, selection ? selection.dragged(entry) : [entry], source);
      },
      onClickCapture: (event: MouseEvent) => {
        if (!selection?.click(entry, event)) return;
        event.preventDefault();
        event.stopPropagation();
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey || event.shiftKey)) return;
        if (!selection?.click(entry, event)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
