/**
 * screens — canonical project destinations for sidebar/drawer navigation.
 *
 * `SCREENS` is the single source of route-valid primary destinations: Home,
 * Work, Chat, and Editor. Auxiliary routed surfaces are deliberately not screens —
 * Settings uses `?settings=` and phone Results uses `?results=` — so desktop
 * placement and pane rendering never need fake destination fallbacks.
 */

import { t } from "@lingui/core/macro";
import type { LucideIcon } from "lucide-react";
import { FolderTree, Home, Layers, MessageSquare } from "lucide-react";

/** Built-in workspace screens — every route-valid `?screen=` value. */
export type ScreenKey = "home" | "work" | "chat" | "context";

export type ScreenMeta = {
  key: ScreenKey;
  icon: LucideIcon;
};

/** Ordered sidebar/drawer nav destinations. */
export const SCREENS: ScreenMeta[] = [
  { key: "home", icon: Home },
  { key: "work", icon: Layers },
  { key: "chat", icon: MessageSquare },
  { key: "context", icon: FolderTree },
];

/** User-facing destination vocabulary; route and domain naming stay stable. */
export function screenLabel(screen: ScreenKey): string {
  switch (screen) {
    case "home":
      return t`Home`;
    case "work":
      return t`Work`;
    case "chat":
      return t`Chat`;
    case "context":
      return t`Editor`;
  }
}
