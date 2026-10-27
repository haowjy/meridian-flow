/**
 * The one adapter every drag source that is not a list row uses: a mention chip, an Editor tab, a
 * path crumb, a Recent row, a receipt entry, an Uploads entry. A source supplies what it names (a
 * document or folder by identity, the name to show, and the view a Copy reads) and gets back the DOM
 * props that make it a drag. It never decides what a drop does: the drop target resolves the
 * identity against the replica and always asks Move, Copy or Cancel (`DragSource` "reference").
 *
 * Desktop only. A source that can't name an entry yet passes null and stays an ordinary control.
 */
import type { CopyContextEntryView } from "@meridian/contracts/protocol";
import type { DragEvent } from "react";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { startEntryDrag } from "./drag-session";
import { type DragEntry, LIVE_VIEW } from "./entry";

/** What a source names. `view` is what the source shows: omit it for the live document. */
export type ReferenceSubject = Omit<DragEntry, "view"> & { view?: CopyContextEntryView };

const NOT_A_DRAG = {};

export function useReferenceDrag(subject: ReferenceSubject | null) {
  const phone = usePhoneShell() === true;
  if (!subject || phone) return NOT_A_DRAG;
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      // A source inside another draggable (a chip in a row) must not also start the outer drag.
      event.stopPropagation();
      startEntryDrag(event, [{ ...subject, view: subject.view ?? LIVE_VIEW }], "reference");
    },
  };
}
