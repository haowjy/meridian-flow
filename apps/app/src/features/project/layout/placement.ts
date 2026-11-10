/**
 * Where the project's surfaces sit, merged with the two panel prefs for render consumers. The
 * centre follows the kind of item the address names: a document fills it with the chat in the
 * dock, a chat fills it with the document the dock holds. The centre slot is never collapsible.
 * A transient hold (`collapsedSlots`, a too-narrow window) collapses slots for as long as it
 * lasts without touching prefs, so the writer's choice returns when it lifts.
 */
import { useMemo } from "react";

import type { ScreenKey } from "../routing/project-route";
import {
  DEFAULT_PANEL_PREFS,
  DEFAULT_SLOT_WIDTHS,
  type PanelPrefs,
  type SlotWidths,
  useProjectSurfacePrefsStore,
} from "./surface-prefs-store";
import {
  type DesktopProjectSlotId,
  PROJECT_SURFACE_IDS,
  type SurfaceId,
  type SurfaceLayoutMap,
  type SurfacePlacementMap,
} from "./types";

/** Stable "nothing held" argument, so the layout memo does not thrash. */
export const NO_COLLAPSED_SLOTS: readonly DesktopProjectSlotId[] = [];

const PLACEMENTS = {
  context: {
    threads: { slot: "rail-l" },
    chat: { slot: "dock" },
    "context-viewer": { slot: "center" },
    "context-rail": { slot: null },
  },
  chat: {
    threads: { slot: "rail-l" },
    chat: { slot: "center" },
    "context-viewer": { slot: null },
    "context-rail": { slot: "dock" },
  },
} as const satisfies Record<ScreenKey, SurfacePlacementMap>;

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

export function mergeSurfaceLayout(
  placements: SurfacePlacementMap,
  widths: SlotWidths = DEFAULT_SLOT_WIDTHS,
  panels: PanelPrefs = DEFAULT_PANEL_PREFS,
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
          ? held || !panels.sidebarOpen
          : slot === "dock"
            ? held || !panels.sideOpen
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
  const widths = useProjectSurfacePrefsStore((state) => state.widths);
  const panels = useProjectSurfacePrefsStore((state) => state.panels);
  return useMemo(
    () => mergeSurfaceLayout(PLACEMENTS[screen], widths, panels, collapsedSlots),
    [collapsedSlots, panels, screen, widths],
  );
}

/** First surface whose placement points at this slot. */
export function occupantOf(layout: SurfaceLayoutMap, slot: DesktopProjectSlotId): SurfaceId | null {
  return PROJECT_SURFACE_IDS.find((surfaceId) => layout[surfaceId].slot === slot) ?? null;
}
