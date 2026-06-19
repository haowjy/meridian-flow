/**
 * Pure screen-to-surface placement for the project project.
 *
 * Purpose: own the only mapping from active screen to surface slot, then merge
 * that placement with device-local prefs for render consumers. Key decision:
 * prefs never influence placement; center-slot surfaces are forced expanded in
 * the merged layout because the main pane is not collapsible; the right dock
 * has its own shared width/collapse pref that overrides the occupant
 * surface's own pref, so the dock reads as one persistent sidebar across
 * screens regardless of which surface is currently inside it.
 *
 * History: `context-files` was intentionally left unplaced (slot: null) on the
 * Context screen. The files explorer renders INSIDE the center `ContextViewer`
 * component (below the tab strip), not as a separate grid column. Its prefs
 * now live in their own dedicated store `context/context-files-store.ts`.
 */
import { useMemo } from "react";

import type { ScreenKey } from "../shell/screens";
import {
  DEFAULT_DOCK_PREFS,
  DEFAULT_SURFACE_PREFS,
  type SlotPrefsMap,
  useProjectSurfacePrefsStore,
} from "./surface-prefs-store";
import type {
  DesktopProjectSlotId,
  SurfaceId,
  SurfaceLayoutMap,
  SurfacePlacement,
  SurfacePlacementMap,
  SurfacePrefsMap,
} from "./types";

function placement(slot: SurfacePlacement["slot"]): SurfacePlacement {
  return { slot };
}

function assertOneActiveSurfacePerSlot(layout: SurfaceLayoutMap): void {
  const surfaceBySlot: Partial<Record<DesktopProjectSlotId, SurfaceId>> = {};
  for (const surfaceId of Object.keys(layout) as SurfaceId[]) {
    const { slot, collapsed } = layout[surfaceId];
    if (!slot || collapsed) continue;

    const existingSurfaceId = surfaceBySlot[slot];
    if (existingSurfaceId) {
      throw new Error(
        `Project layout invariant failed: slot "${slot}" has multiple active surfaces (${existingSurfaceId}, ${surfaceId}).`,
      );
    }
    surfaceBySlot[slot] = surfaceId;
  }
}

const HIDDEN_PLACEMENT: SurfacePlacementMap = {
  threads: placement(null),
  chat: placement(null),
  "context-viewer": placement(null),
  "context-rail": placement(null),
};

export function placeSurfaces(screen: ScreenKey): SurfacePlacementMap {
  switch (screen) {
    case "home":
      return {
        ...HIDDEN_PLACEMENT,
        threads: placement("rail-l"),
        chat: placement("dock"),
      };
    case "chat":
      return {
        ...HIDDEN_PLACEMENT,
        threads: placement("rail-l"),
        chat: placement("center"),
        "context-rail": placement("dock"),
      };
    case "context":
      // The files explorer renders INSIDE `ContextViewer`, not as a grid
      // slot; its prefs live in context/context-files-store.ts.
      return {
        ...HIDDEN_PLACEMENT,
        threads: placement("rail-l"),
        "context-viewer": placement("center"),
        chat: placement("dock"),
      };
  }
}

export function mergeSurfaceLayout(
  placements: SurfacePlacementMap,
  prefs: SurfacePrefsMap,
  slotPrefs: SlotPrefsMap = { dock: DEFAULT_DOCK_PREFS },
): SurfaceLayoutMap {
  const dockPref = slotPrefs.dock ?? DEFAULT_DOCK_PREFS;
  const layout = {} as SurfaceLayoutMap;
  for (const surfaceId of Object.keys(placements) as SurfaceId[]) {
    const surfacePlacement = placements[surfaceId];
    const defaultPrefs = DEFAULT_SURFACE_PREFS[surfaceId];
    const persistedPrefs = prefs[surfaceId];
    const surfacePrefs = {
      width: persistedPrefs?.width ?? defaultPrefs.width,
      collapsed: persistedPrefs?.collapsed ?? defaultPrefs.collapsed,
    };
    // Whichever surface lands in the dock slot reads the shared dock pref;
    // the surface's own width/collapsed pref is ignored while it is docked.
    const isDocked = surfacePlacement.slot === "dock";
    const widthPref = isDocked ? dockPref.width : surfacePrefs.width;
    const collapsedPref = isDocked ? dockPref.collapsed : surfacePrefs.collapsed;
    layout[surfaceId] = {
      ...surfacePlacement,
      width: widthPref,
      collapsed: surfacePlacement.slot === "center" ? false : collapsedPref,
    };
  }
  if (import.meta.env.DEV) {
    assertOneActiveSurfacePerSlot(layout);
  }
  return layout;
}

export function useProjectLayout(screen: ScreenKey): SurfaceLayoutMap {
  const prefs = useProjectSurfacePrefsStore((state) => state.prefs);
  const slotPrefs = useProjectSurfacePrefsStore((state) => state.slotPrefs);
  return useMemo(
    () => mergeSurfaceLayout(placeSurfaces(screen), prefs, slotPrefs),
    [prefs, screen, slotPrefs],
  );
}
