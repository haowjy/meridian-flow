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
    draggable?: boolean;
    source?: DragSource;
  },
) {
  const { selection, selected, rowProps } = useEntrySelectionRow(entry, active);
  return {
    selected,
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
      // Enter with a modifier sends no click (Chromium clicks only on a plain Enter's keypress;
      // macOS sends none for Cmd+Enter), so the keyboard's selection gesture is read here.
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey || event.shiftKey)) return;
        if (!selection?.click(entry, event)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
