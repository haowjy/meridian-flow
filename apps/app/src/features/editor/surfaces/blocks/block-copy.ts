import { t } from "@lingui/core/macro";

// Straight at the primitive, not through `chrome/index.ts`: that barrel also
// carries the surface registry this lane is listed in, and the round trip is a
// module cycle.
import { shortcutLabel } from "../../chrome/shortcut-label";

export function blockHandleLabel(): string {
  return t`Move or change this block`;
}

export function blockMenuLabel(id: "moveUp" | "moveDown" | "duplicate" | "turnInto" | "delete") {
  switch (id) {
    case "moveUp":
      return t`Move up`;
    case "moveDown":
      return t`Move down`;
    case "duplicate":
      return t`Duplicate`;
    case "turnInto":
      return t`Turn into`;
    case "delete":
      return t`Delete`;
  }
}

export function blockMoveShortcut(direction: "up" | "down"): string {
  return shortcutLabel(`Alt+${direction === "up" ? "↑" : "↓"}`);
}
