import type { CopyContextEntryView } from "@meridian/contracts/protocol";
import type { DragEvent } from "react";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { startEntryDrag } from "./drag-session";
import { type DragEntry, LIVE_VIEW } from "./entry";

export type ReferenceSubject = Omit<DragEntry, "view"> & { view?: CopyContextEntryView };

const NOT_A_DRAG = {};

/**
 * The start every reference source goes through, whatever element it is: it defaults the view,
 * keeps a source inside another draggable (a chip in a row) from also starting the outer drag,
 * and publishes the drag with `source: "reference"`.
 */
function startReferenceDrag(
  event: Pick<globalThis.DragEvent, "dataTransfer" | "stopPropagation">,
  subject: ReferenceSubject,
) {
  event.stopPropagation();
  startEntryDrag(event, [{ ...subject, view: subject.view ?? LIVE_VIEW }], "reference");
}

export function useReferenceDragStart() {
  return usePhoneShell() === true ? null : startReferenceDrag;
}

export function useReferenceDrag(subject: ReferenceSubject | null) {
  const start = useReferenceDragStart();
  if (!subject || !start) return NOT_A_DRAG;
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => start(event, subject),
  };
}
