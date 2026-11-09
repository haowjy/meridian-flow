/**
 * Pure mode-to-surface placement for the project, merged with the mode's panel
 * prefs for render consumers. The centre slot is never collapsible. A transient
 * hold (`collapsedSlots`, review's prose focus) collapses slots for as long as it
 * lasts without touching prefs, so the writer's choice returns when it lifts.
 */
import { useMemo } from "react";

import type { ScreenKey } from "../shell/screens";
import {
  DEFAULT_MODE_PANELS,
  DEFAULT_SLOT_WIDTHS,
  type ModePanels,
  type SlotWidths,
  useProjectSurfacePrefsStore,
} from "./surface-prefs-store";
import {
  type DesktopProjectSlotId,
  type ModeKey,
  PROJECT_SURFACE_IDS,
  type SurfaceId,
  type SurfaceLayoutMap,
  type SurfacePlacement,
  type SurfacePlacementMap,
} from "./types";

/** The mode a destination shows in; the Work page reads as Chat until it goes. */
export function modeOf(screen: ScreenKey): ModeKey {
  return screen === "context" ? "write" : "chat";
}

/** Stable "nothing held" argument, so the layout memo does not thrash. */
export const NO_COLLAPSED_SLOTS: readonly DesktopProjectSlotId[] = [];

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
    case "work":
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
