/** What a list row needs to be selectable and draggable. */
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { startEntryDrag } from "./drag-session";
import type { DragEntry, DragSource } from "./entry";
import { type SelectionGrant, useEntrySelectionRow } from "./selection";

export function useEntryRow(
  entry: DragEntry,
  {
    active,
    draggable = true,
    source = "list-row",
    grants,
  }: {
    active: boolean;
    /** False for a row that names nothing a drag could act on (a navigation-only folder). */
    draggable?: boolean;
    source?: DragSource;
    /** What a selection's menu may do with this row. */
    grants: readonly SelectionGrant[];
  },
) {
  const { selection, selected, rowProps } = useEntrySelectionRow(entry, active, grants);
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
    /** A selection gesture (Ctrl/Cmd or Shift) selects instead of opening or toggling. */
    activate:
      (open: () => void) =>
      (event: MouseEvent | KeyboardEvent): void => {
        if (selection?.click(entry, event)) return;
        open();
      },
  };
}
