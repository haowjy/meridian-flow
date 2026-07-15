/**
 * Desktop project slot topology and grid structure for stable surfaces.
 *
 * Purpose: define the real project project slots as data instead of baking
 * desktop geometry into the registry/grid/shell. Key decision: this file
 * co-locates the static grid template with the slot list while runtime width
 * CSS variable values remain owned by the shell. Slot className fully owns
 * the visual chrome, and region separation is purely TONAL (no borders, no
 * shadows): the lacquered shelf (`rail-l`), the whisper chrome that the tab
 * band and the whole dock share (`--color-sidebar`), and the lit page rising
 * out of it. SlotGrid never branches on slot kind.
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
  // Shelf: lacquer + depth atmosphere + local cream re-theme (globals.css).
  { id: "rail-l", className: "relative shelf-surface" },
  // Center: chrome, not paper — every pane's h-10 band sits directly on it
  // (continuous with the dock) and the pane body rises as a `page-sheet`.
  { id: "center", className: "chrome-field" },
  // Dock: the chrome material (≡ the tab band) with airlight pooling at its
  // floor — light surfaces breathe light, the lacquer shelf breathes shadow.
  { id: "dock", className: "relative dock-surface" },
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
