import { type DragEvent, useMemo, useState } from "react";
import { activeDragSession } from "../../context/entry-drag/drag-session";
import { useDeleteContextEntries } from "../../context/use-delete-context-entries";
import type { SourceDrop } from "./SourcePane";

/**
 * Trash as a drop target: rows dragged onto it are deleted at once. Trash's
 * own rows are already deleted, so a drag of them passes over quietly.
 */
export function useTrashDrop(projectId: string): SourceDrop {
  const deleteEntries = useDeleteContextEntries(projectId);
  const [over, setOver] = useState(false);
  const dropProps = useMemo(() => {
    // Accepting on enter as well as over: a drag released right after it arrives sends no `dragover`.
    const accept = (event: DragEvent) => {
      const drag = activeDragSession();
      if (!drag || drag.source === "trash") return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(true);
    };
    return {
      onDragEnter: accept,
      onDragOver: accept,
      onDragLeave() {
        setOver(false);
      },
      onDrop(event: DragEvent) {
        setOver(false);
        // Read before the drag session ends with the drop.
        const drag = activeDragSession();
        if (!drag || drag.source === "trash") return;
        event.preventDefault();
        deleteEntries(drag.entries);
      },
    };
  }, [deleteEntries]);
  return { dropProps, dropState: over ? "over" : "idle" };
}
