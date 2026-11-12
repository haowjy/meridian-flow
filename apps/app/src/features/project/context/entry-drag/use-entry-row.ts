/** What a list row needs to be selectable and draggable. */
import type { DragEvent, MouseEvent } from "react";
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
      // A selection gesture (Ctrl/Cmd or Shift) selects instead of opening or toggling, before
      // the row's own click (or a link's navigation) sees it.
      onClickCapture: (event: MouseEvent) => {
        if (!selection?.click(entry, event)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
