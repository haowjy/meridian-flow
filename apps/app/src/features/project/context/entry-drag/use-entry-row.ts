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
  /** A selection gesture (Ctrl/Cmd or Shift) selects; true when it did, so the click must not open. */
  const select = (event: MouseEvent | KeyboardEvent): boolean =>
    selection?.click(entry, event) ?? false;
  return {
    selected,
    rowProps: {
      ...rowProps,
      draggable: Boolean(selection?.draggable && draggable),
      onDragStart: (event: DragEvent) => {
        event.stopPropagation();
        startEntryDrag(event, selection ? selection.dragged(entry) : [entry], source);
      },
    },
    select,
    /** A selection gesture (Ctrl/Cmd or Shift) selects instead of opening or toggling. */
    activate:
      (open: () => void) =>
      (event: MouseEvent | KeyboardEvent): void => {
        if (!select(event)) open();
      },
  };
}
