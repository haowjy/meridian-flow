/**
 * The desktop project's three fixed slots: the sidebar, main and the side. Hosts are keyed by
 * what they hold and placed in a slot by grid-area; a host in no slot stays mounted, parked.
 */
import type { CSSProperties } from "react";

/** Desktop slot topology: `rail-l` is the sidebar, `center` main, `dock` the side. */
export type DesktopProjectSlotId = "rail-l" | "center" | "dock";

/** The slots a writer opens, closes and resizes. */
export type PanelSlotId = Exclude<DesktopProjectSlotId, "center">;

/** Whether each panel is open and how wide it is, after a narrow window's hold. */
export type DesktopPanels = Record<PanelSlotId, { open: boolean; width: number }>;

export type SlotDefinition = {
  id: DesktopProjectSlotId;
  /** CSS grid-area name. Defaults to `id`. */
  area?: string;
  /** Tailwind classes that fully own the slot's chrome (background, rounding, shadows, borders). */
  className?: string;
  style?: CSSProperties;
};
