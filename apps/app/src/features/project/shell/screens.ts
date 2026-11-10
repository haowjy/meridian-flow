/**
 * screens — canonical project destinations for sidebar/drawer navigation.
 *
 * `SCREENS` is the single source of route-valid primary destinations: Chat
 * and Editor. Auxiliary routed surfaces are deliberately not screens —
 * Settings uses `?settings=` — so desktop
 * placement and pane rendering never need fake destination fallbacks.
 */

import { t } from "@lingui/core/macro";
import type { LucideIcon } from "lucide-react";
import { FolderTree, MessageSquare } from "lucide-react";

/** Built-in workspace screens — normalized layout keys, independent of browser address grammar. */
export type ScreenKey = "chat" | "context";

export type ScreenMeta = {
  key: ScreenKey;
  icon: LucideIcon;
};

/** Ordered sidebar/drawer nav destinations. */
export const SCREENS: ScreenMeta[] = [
  { key: "chat", icon: MessageSquare },
  { key: "context", icon: FolderTree },
];

/** User-facing destination vocabulary; route and domain naming stay stable. */
export function screenLabel(screen: ScreenKey): string {
  switch (screen) {
    case "chat":
      return t`Chat`;
    case "context":
      return t`Editor`;
  }
}
