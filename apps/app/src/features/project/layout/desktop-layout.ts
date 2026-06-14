// @ts-nocheck
/**
 * Desktop project slot topology and grid structure for stable surfaces.
 *
 * Purpose: define the real project project slots as data instead of baking
 * desktop geometry into the registry/grid/shell. Key decision: this file
 * co-locates the static grid template with the slot list while runtime width
 * CSS variable values remain owned by the shell. Slot className fully owns
 * the visual chrome — rounded inside corners + inward shadow on rails, flat
 * tint on inner columns — so SlotGrid never branches on slot kind.
 *
 * History: the optional `context-header` row and the `files` column are gone
 * — the Context destination absorbs its sidebar/dock expand toggles into the
 * tab strip and now renders the file explorer INSIDE `ContextViewer` (below
 * the tab strip), so the grid is a single body row across every screen with
 * no files column. Home/Settings render their route pane in `center` (no
 * center surface present); Chat/Context render only the center surface.
 */
import type { DesktopProjectSlotId, SlotDefinition } from "./types";

export type { DesktopProjectSlotId } from "./types";

export const DESKTOP_PROJECT_SLOTS: SlotDefinition[] = [
  { id: "rail-l", className: "relative z-10 rounded-r-xl bg-sidebar shadow-rail-left" },
  { id: "center", className: "bg-background" },
  { id: "dock", className: "relative z-10 rounded-l-xl bg-sidebar shadow-rail-right" },
];

/**
 * Single grid template across every screen. The files column lives INSIDE
 * the center surface (`ContextViewer`) now, not as its own grid track.
 */
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

export type DesktopProjectSlots = readonly DesktopProjectSlotId[];
