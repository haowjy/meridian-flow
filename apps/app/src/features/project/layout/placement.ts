/**
 * Pure mode-to-surface placement for the project, merged with the mode's panel
 * prefs for render consumers. The centre slot is never collapsible. A transient
 * hold (`collapsedSlots`, a too-narrow window) collapses slots for as long as it
 * lasts without touching prefs, so the writer's choice returns when it lifts.
 */
import { useMemo } from "react";

import type { ScreenKey } from "../shell/screens";
import { MODES, type ModeKey, type ModePanels, modeMeta } from "./modes";
import {
  DEFAULT_MODE_PANELS,
  DEFAULT_SLOT_WIDTHS,
  type SlotWidths,
  useProjectSurfacePrefsStore,
} from "./surface-prefs-store";
import {
  type DesktopProjectSlotId,
  PROJECT_SURFACE_IDS,
  type SurfaceId,
  type SurfaceLayoutMap,
  type SurfacePlacement,
  type SurfacePlacementMap,
} from "./types";

/** The mode a destination shows in. */
export function modeOf(screen: ScreenKey): ModeKey {
  return (MODES.find((mode) => mode.screen === screen) ?? modeMeta("chat")).key;
}

/** Stable "nothing held" argument, so the layout memo does not thrash. */
export const NO_COLLAPSED_SLOTS: readonly DesktopProjectSlotId[] = [];

function _placement(slot: SurfacePlacement["slot"]): SurfacePlacement {
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

export function placeSurfaces(screen: ScreenKey): SurfacePlacementMap {
  return modeMeta(modeOf(screen)).placement;
}

export function mergeSurfaceLayout(
  placements: SurfacePlacementMap,
  widths: SlotWidths = DEFAULT_SLOT_WIDTHS,
  panels: ModePanels = DEFAULT_MODE_PANELS.chat,
  collapsedSlots: readonly DesktopProjectSlotId[] = NO_COLLAPSED_SLOTS,
): SurfaceLayoutMap {
  const layout = {} as SurfaceLayoutMap;
  for (const surfaceId of Object.keys(placements) as SurfaceId[]) {
    const { slot } = placements[surfaceId];
    const held = slot !== null && collapsedSlots.includes(slot);
    layout[surfaceId] = {
      slot,
      width: slot === "rail-l" || slot === "dock" ? widths[slot] : 0,
      collapsed:
        slot === "rail-l"
          ? held || !panels.railOpen
          : slot === "dock"
            ? held || !panels.dockOpen
            : slot === null,
    };
  }
  if (import.meta.env.DEV) {
    assertOneActiveSurfacePerSlot(layout);
  }
  return layout;
}

export function useProjectLayout(
  screen: ScreenKey,
  collapsedSlots: readonly DesktopProjectSlotId[] = NO_COLLAPSED_SLOTS,
): SurfaceLayoutMap {
  const mode = modeOf(screen);
  const widths = useProjectSurfacePrefsStore((state) => state.widths);
  const panels = useProjectSurfacePrefsStore((state) => state.modes[mode]);
  return useMemo(
    () => mergeSurfaceLayout(placeSurfaces(screen), widths, panels, collapsedSlots),
    [collapsedSlots, panels, screen, widths],
  );
}

/** First surface whose placement points at this slot. */
export function occupantOf(layout: SurfaceLayoutMap, slot: DesktopProjectSlotId): SurfaceId | null {
  return PROJECT_SURFACE_IDS.find((surfaceId) => layout[surfaceId].slot === slot) ?? null;
}
