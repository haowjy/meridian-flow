/**
 * Writer-facing copy for the block handle and its menu.
 *
 * One place, because law 5 is only satisfied when a refused verb reads as an
 * answer, and the refusals for whole-block conversions are the toolbar's
 * (`blockTypeReasonMessage`) rather than a second wording of the same rule.
 */
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

/**
 * The keyboard twin of a drag, spelled the way the writer's own keyboard
 * spells it. Alt is Option on Apple keyboards, and a menu that says "Alt"
 * beside a key labelled ⌥ is a shortcut the writer has to translate.
 */
export function blockMoveShortcut(direction: "up" | "down"): string {
  return shortcutLabel(`Alt+${direction === "up" ? "↑" : "↓"}`);
}
