// @ts-nocheck
/**
 * screens — canonical workbench destinations for sidebar/drawer navigation.
 *
 * `SCREENS` is the single source of route-valid primary destinations: Home,
 * Chat, and Context. Auxiliary routed surfaces are deliberately not screens —
 * Settings uses `?settings=` and phone Results uses `?results=` — so desktop
 * placement and pane rendering never need fake destination fallbacks.
 */
import type { LucideIcon } from "lucide-react";
import { FolderTree, Home, MessageSquare } from "lucide-react";

/** Built-in workspace screens — every route-valid `?screen=` value. */
export type ScreenKey = "home" | "chat" | "context";

export type ScreenMeta = {
  key: ScreenKey;
  label: string;
  icon: LucideIcon;
};

/** Ordered sidebar/drawer nav destinations. */
export const SCREENS: ScreenMeta[] = [
  { key: "home", label: "Home", icon: Home },
  { key: "chat", label: "Chat", icon: MessageSquare },
  { key: "context", label: "Context", icon: FolderTree },
];
