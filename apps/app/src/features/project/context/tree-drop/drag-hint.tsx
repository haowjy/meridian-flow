/**
 * Draws the label beside the pointer that says what dropping here will do
 * ("Move to Act 2", "Can't go inside itself"). The store is in the editor's
 * landing code.
 */
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  currentDragHint,
  endDragHint,
  subscribeDragHint,
} from "@/core/editor/landing/drag-hint-store";
import { cn } from "@/lib/utils";

/** Mounted once per project view. */
export function DragHint() {
  const current = useSyncExternalStore(subscribeDragHint, currentDragHint, () => null);
  useEffect(() => {
    window.addEventListener("dragend", endDragHint);
    window.addEventListener("drop", endDragHint);
    return () => {
      window.removeEventListener("dragend", endDragHint);
      window.removeEventListener("drop", endDragHint);
    };
  }, []);
  if (!current) return null;
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 max-w-72 overflow-hidden rounded-md text-xs shadow-sm"
      style={{ left: current.x + 14, top: current.y + 18 }}
    >
      <div
        className={cn(
          "px-2 py-1",
          // A refusal is not an error: ink, not the deletion red.
          current.refused ? "bg-foreground text-background" : "bg-primary text-primary-foreground",
        )}
      >
        {current.label}
      </div>
    </div>,
    document.body,
  );
}
