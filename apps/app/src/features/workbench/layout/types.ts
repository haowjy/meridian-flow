// @ts-nocheck
/**
 * Flat-grid layout contracts for the workbench workbench.
 *
 * Purpose: name the fixed workbench surfaces, desktop slots, and the two layout
 * concerns that combine at render time. Key decision: persisted prefs are only
 * width/collapsed state, while slot placement is derived from the active screen;
 * each slot has at most one surface and surfaces never use portal identities.
 *
 * History: `context-files` was in `WORKBENCH_SURFACE_IDS` because its
 * width/collapsed prefs used to persist in the shared workbench store, but
 * it never had a grid slot — the file explorer renders INSIDE the center
 * `ContextViewer` component (below the tab strip). Its prefs now live in
 * their own dedicated store `context/context-files-store.ts` (key
 * `meridian:context-files-panel`).
 */
import type { CSSProperties } from "react";

export const WORKBENCH_SURFACE_IDS = ["threads", "chat", "context-viewer", "context-rail"] as const;

/** Stable logical identity for stateful workbench surfaces. */
export type SurfaceId = (typeof WORKBENCH_SURFACE_IDS)[number];

/** Desktop slot topology for the workbench workbench. */
export type DesktopWorkbenchSlotId = "rail-l" | "center" | "dock";

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
  slot: DesktopWorkbenchSlotId | null;
};

/** Merged render-time layout for one surface. */
export type SurfaceLayout = SurfacePlacement & SurfacePrefs;

export type SurfacePrefsMap = Record<SurfaceId, SurfacePrefs>;
export type SurfacePlacementMap = Record<SurfaceId, SurfacePlacement>;
export type SurfaceLayoutMap = Record<SurfaceId, SurfaceLayout>;

export type SlotDefinition = {
  id: DesktopWorkbenchSlotId;
  /** CSS grid-area name. Defaults to `id`. */
  area?: string;
  /** Tailwind classes that fully own the slot's chrome (background, rounding, shadows, borders). */
  className?: string;
  style?: CSSProperties;
};
