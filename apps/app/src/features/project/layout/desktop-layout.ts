/**
 * Desktop project slot topology and grid structure for stable surfaces.
 *
 * Purpose: define the real project project slots as data instead of baking
 * desktop geometry into the registry/grid/shell. Key decision: this file
 * co-locates the static grid template with the slot list while runtime width
 * CSS variable values remain owned by the shell. Slot className fully owns
 * the visual chrome — rails are flush Quiet Pro sidebar regions divided from the
 * center by a hairline border (integrated, not floating) — so SlotGrid never
 * branches on slot kind.
 *
 * History: the optional `context-header` row and the `files` column are gone
 * — the Editor destination absorbs its sidebar/dock expand toggles into the
 * tab strip, while the persistent left sidebar owns the file explorer. The
 * grid is a single body row across every screen with no files column.
 * Home/Settings render their route pane in `center` (no
 * center surface present); Chat/Context render only the center surface.
 */
import type { DesktopProjectSlotId, SlotDefinition } from "./types";

export type { DesktopProjectSlotId } from "./types";

export const DESKTOP_PROJECT_SLOTS: SlotDefinition[] = [
  { id: "rail-l", className: "relative bg-sidebar border-r border-border" },
  { id: "center", className: "bg-background" },
  { id: "dock", className: "relative bg-sidebar border-l border-border" },
];

/**
 * Single grid template across every screen. The file tree lives in `rail-l`,
 * not as its own grid track.
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
