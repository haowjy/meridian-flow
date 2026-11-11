/**
 * The desktop's three fixed slots as data: the sidebar (`rail-l`), main (`center`) and the side
 * (`dock`), with the one grid template they sit in. Slot className owns the visual chrome, and
 * region separation is tonal: one chrome for the sidebar, main's band and the side
 * (`--color-chrome`), and the lit page rising out of it.
 */
import type { SlotDefinition } from "./types";

export const DESKTOP_PROJECT_SLOTS: SlotDefinition[] = [
  // The side panels and the centre's band are one chrome surface with no lines between
  // them; the page is the `page-sheet` set into it.
  { id: "rail-l", className: "relative bg-chrome" },
  { id: "center", className: "chrome-field" },
  { id: "dock", className: "relative bg-chrome" },
];

/** One grid template; the file tree lives in `rail-l`, not as its own track. */
export function getDesktopGridTemplate(): {
  areas: string;
  columns: string;
  rows?: string;
} {
  return {
    areas: '"rail-l left-resize center dock-resize dock"',
    columns:
      "var(--project-left-width) var(--project-left-handle-width) minmax(var(--project-main-min-width), 1fr) var(--project-dock-handle-width) var(--project-dock-width)",
  };
}
