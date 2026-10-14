/**
 * The line beside the pointer that says what dropping here will do ("Move to
 * Act 2", "Can't go inside itself"). The lit target sets it; it follows the
 * pointer and goes away when the drag leaves every target or ends.
 */
import { type DragEvent, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type Hint = { owner: string; label: string; refused: boolean; x: number; y: number };

let hint: Hint | null = null;
const listeners = new Set<() => void>();

function set(next: Hint | null) {
  hint = next;
  for (const listener of listeners) listener();
}

export function showDragHint(
  owner: string,
  verdict: { kind: "accept" | "refuse"; label: string },
  event: Pick<DragEvent, "clientX" | "clientY">,
) {
  const refused = verdict.kind === "refuse";
  if (
    hint?.owner === owner &&
    hint.label === verdict.label &&
    hint.refused === refused &&
    hint.x === event.clientX &&
    hint.y === event.clientY
  )
    return;
  set({ owner, label: verdict.label, refused, x: event.clientX, y: event.clientY });
}

/** Only the target that set the hint clears it, so the next target's hint survives. */
export function clearDragHint(owner: string) {
  if (hint?.owner === owner) set(null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mounted once per project view. */
export function DragHint() {
  const current = useSyncExternalStore(
    subscribe,
    () => hint,
    () => null,
  );
  useEffect(() => {
    const end = () => set(null);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, []);
  if (!current) return null;
  return createPortal(
    <div
      aria-hidden
      className={cn(
        "pointer-events-none fixed z-50 rounded-md px-2 py-1 text-xs shadow-sm",
        // A refusal is not an error: ink, not the deletion red.
        current.refused ? "bg-foreground text-background" : "bg-primary text-primary-foreground",
      )}
      style={{ left: current.x + 14, top: current.y + 18 }}
    >
      {current.label}
    </div>,
    document.body,
  );
}
