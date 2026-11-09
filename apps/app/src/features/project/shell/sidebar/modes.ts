import { t } from "@lingui/core/macro";
import type { LucideIcon } from "lucide-react";
import { MessageSquare, PenLine } from "lucide-react";
import type { ModeKey } from "../../layout/types";
import type { ScreenKey } from "../screens";

export type ModeMeta = {
  key: ModeKey;
  /** The destination that shows this mode until modes replace destinations (PR 9). */
  screen: ScreenKey;
  icon: LucideIcon;
};

/** The project's modes, in switch order. A new mode is one entry here and its placement. */
export const MODES: readonly ModeMeta[] = [
  { key: "write", screen: "context", icon: PenLine },
  { key: "chat", screen: "chat", icon: MessageSquare },
];

export function modeLabel(mode: ModeKey): string {
  switch (mode) {
    case "write":
      return t`Write`;
    case "chat":
      return t`Chat`;
  }
}
