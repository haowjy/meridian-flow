/**
 * Writer-facing copy for the block handle and its menu.
 *
 * One place, because law 5 is only satisfied when a refused verb reads as an
 * answer, and the refusals for whole-block conversions are the toolbar's
 * (`blockTypeReasonMessage`) rather than a second wording of the same rule.
 */
import { t } from "@lingui/core/macro";

import type { TurnIntoTargetId } from "./turn-into";

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

export function turnIntoLabel(id: TurnIntoTargetId): string {
  switch (id) {
    case "paragraph":
      return t`Paragraph`;
    case "heading1":
      return t`Heading 1`;
    case "heading2":
      return t`Heading 2`;
    case "heading3":
      return t`Heading 3`;
    case "bulletList":
      return t`Bulleted list`;
    case "orderedList":
      return t`Numbered list`;
    case "quote":
      return t`Quote`;
    case "codeBlock":
      return t`Code block`;
  }
}

/**
 * The keyboard twin of a drag, spelled the way the writer's own keyboard
 * spells it. Alt is Option on Apple keyboards, and a menu that says "Alt"
 * beside a key labelled ⌥ is a shortcut the writer has to translate.
 */
export function blockMoveShortcut(direction: "up" | "down"): string {
  const arrow = direction === "up" ? "↑" : "↓";
  return isAppleKeyboard() ? `⌥${arrow}` : `Alt+${arrow}`;
}

function isAppleKeyboard(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}
