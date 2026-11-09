import { t } from "@lingui/core/macro";
import type { LucideIcon } from "lucide-react";
import { MessageSquare, PenLine } from "lucide-react";

import type { ScreenKey } from "../shell/screens";
import type { SurfacePlacement, SurfacePlacementMap } from "./types";

/** Whether a mode's left rail and dock start open; the writer's choice is stored per mode. */
export type ModePanels = { railOpen: boolean; dockOpen: boolean };

type ModeDef = {
  key: string;
  label: () => string;
  icon: LucideIcon;
  /** The destination that shows this mode until modes replace destinations. */
  screen: ScreenKey;
  defaultPanels: ModePanels;
  /** Where each surface sits while the mode shows; the centre holds what fills it. */
  placement: SurfacePlacementMap;
};

function placed(slots: Partial<Record<keyof SurfacePlacementMap, SurfacePlacement["slot"]>>) {
  return {
    threads: { slot: slots.threads ?? null },
    chat: { slot: slots.chat ?? null },
    "context-viewer": { slot: slots["context-viewer"] ?? null },
    "context-rail": { slot: slots["context-rail"] ?? null },
  } satisfies SurfacePlacementMap;
}

/**
 * The main modes, in switch order. A new mode is one entry here, a centre component
 * for its screen, and nothing else.
 */
export const MODES = [
  {
    key: "write",
    label: () => t`Write`,
    icon: PenLine,
    screen: "context",
    // Write gives the page the room.
    defaultPanels: { railOpen: true, dockOpen: false },
    placement: placed({ threads: "rail-l", "context-viewer": "center", chat: "dock" }),
  },
  {
    key: "chat",
    label: () => t`Chat`,
    icon: MessageSquare,
    screen: "chat",
    // Chat shows the page beside the conversation.
    defaultPanels: { railOpen: true, dockOpen: true },
    placement: placed({ threads: "rail-l", chat: "center", "context-rail": "dock" }),
  },
] as const satisfies readonly ModeDef[];

export type ModeMeta = (typeof MODES)[number];
/** Write puts the page in the centre, Chat the conversation; each keeps its own panels. */
export type ModeKey = ModeMeta["key"];
export const MODE_KEYS = MODES.map((mode) => mode.key);

export function modeMeta(mode: ModeKey): ModeMeta {
  return MODES.find((entry) => entry.key === mode) as ModeMeta;
}

export function modeLabel(mode: ModeKey): string {
  return modeMeta(mode).label();
}
