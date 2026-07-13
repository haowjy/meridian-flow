/**
 * Flat-grid layout contracts for the project project.
 *
 * Purpose: name the fixed project surfaces, desktop slots, and the two layout
 * concerns that combine at render time. Key decision: persisted prefs are only
 * width/collapsed state, while slot placement is derived from the active screen;
 * each slot has at most one surface and surfaces never use portal identities.
 *
 * The file explorer renders inside the persistent `threads` sidebar surface,
 * not as another grid slot.
 */
import type { CSSProperties } from "react";

export const PROJECT_SURFACE_IDS = ["threads", "chat", "context-viewer", "context-rail"] as const;

/** Stable logical identity for stateful project surfaces. */
export type SurfaceId = (typeof PROJECT_SURFACE_IDS)[number];

/** Desktop slot topology for the project project. */
export type DesktopProjectSlotId = "rail-l" | "center" | "dock";

/** Device-local surface prefs persisted across sessions. */
export type SurfacePrefs = {
  /** Last committed expanded width in CSS pixels. */
  width: number;
  /** Collapsed surfaces stay mounted in the grid parent but park offscreen. */
  collapsed: boolean;
};

/** Pure route/screen-derived placement for one surface. */
export type SurfacePlacement = {
  /** Null means the active screen intentionally leaves the surface dormant. */
  slot: DesktopProjectSlotId | null;
};

/** Merged render-time layout for one surface. */
export type SurfaceLayout = SurfacePlacement & SurfacePrefs;

export type SurfacePrefsMap = Record<SurfaceId, SurfacePrefs>;
export type SurfacePlacementMap = Record<SurfaceId, SurfacePlacement>;
export type SurfaceLayoutMap = Record<SurfaceId, SurfaceLayout>;

export type SlotDefinition = {
  id: DesktopProjectSlotId;
  /** CSS grid-area name. Defaults to `id`. */
  area?: string;
  /** Tailwind classes that fully own the slot's chrome (background, rounding, shadows, borders). */
  className?: string;
  style?: CSSProperties;
};
