import { useMemo } from "react";
import { useProjectSurfacePrefsStore } from "./surface-prefs-store";
import type { DesktopPanels, PanelSlotId } from "./types";

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
