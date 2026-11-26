import type { CSSProperties } from "react";

export type DesktopProjectSlotId = "rail-l" | "center" | "side";

export type PanelSlotId = Exclude<DesktopProjectSlotId, "center">;

export type DesktopPanels = Record<PanelSlotId, { open: boolean; width: number }>;

export type SlotDefinition = {
  id: DesktopProjectSlotId;
  area?: string;
  className?: string;
  style?: CSSProperties;
};
