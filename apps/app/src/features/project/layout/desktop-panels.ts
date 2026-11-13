/**
 * The two panels' open state and widths for render, merged from the writer's prefs and a
 * narrow window's hold. The hold (`held`) closes a panel for as long as it lasts without
 * touching prefs, so the writer's choice returns when it lifts.
 */
import { useMemo } from "react";
import { useProjectSurfacePrefsStore } from "./surface-prefs-store";
import type { DesktopPanels, PanelSlotId } from "./types";

/** Stable "nothing held" argument, so the panels memo does not thrash. */
export const NO_HELD_PANELS: readonly PanelSlotId[] = [];

export function useDesktopPanels(held: readonly PanelSlotId[] = NO_HELD_PANELS): DesktopPanels {
  const widths = useProjectSurfacePrefsStore((state) => state.widths);
  const panels = useProjectSurfacePrefsStore((state) => state.panels);
  return useMemo(
    () => ({
      "rail-l": { open: panels.sidebarOpen && !held.includes("rail-l"), width: widths["rail-l"] },
      side: { open: panels.sideOpen && !held.includes("side"), width: widths.side },
    }),
    [held, panels, widths],
  );
}
