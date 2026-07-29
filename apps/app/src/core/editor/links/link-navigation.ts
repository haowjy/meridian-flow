/**
 * What a click on a link does, and where following it goes.
 *
 * Ruling 4: click follows. That is Notion's behavior and it is the one the
 * design picked, even inside an editable surface — hover has already shown the
 * destination, so no click is blind. The caret is still reachable: Alt+Click,
 * or any click that travelled far enough to be a drag, places it instead.
 *
 * Ruling 9 settles the external guard: none. A click on an external link opens
 * the new tab immediately, because a stray tab is cheaper than a tax on every
 * deliberate follow. If that is ever reopened (mockup 06 state F), the whole
 * flip is `linkClickAction` returning a third action and the surface rendering
 * a chip — no consumer of this module learns a new shape.
 */

import type { LinkTarget } from "./link-target";

/**
 * Where a followed internal link goes. Registered by the app shell, because
 * only it knows the project, the work, and the router; the editor core knows
 * only that the writer asked to go there.
 */
export type InternalLinkNavigator = (target: LinkTarget) => void;

export type LinkClickAction = "follow" | "place-caret";

/**
 * Pointer travel that turns a click into a drag, matching the chrome kernel's
 * sweep slop. The kernel's own sweep flag cannot answer this: it clears on
 * `mouseup`, and `click` fires after that.
 */
export const LINK_CLICK_SLOP_PX = 4;

export type LinkClickGesture = {
  /** Alt (Option on macOS): the writer wants the caret, not the destination. */
  altKey: boolean;
  /** Manhattan distance from where the press started to where it ended. */
  travelledPx: number;
};

export function linkClickAction({ altKey, travelledPx }: LinkClickGesture): LinkClickAction {
  if (altKey) return "place-caret";
  // A sweep that started and ended on the same link is a selection, not a
  // follow: the writer was highlighting text to read it or point at it (law 7).
  if (travelledPx >= LINK_CLICK_SLOP_PX) return "place-caret";
  return "follow";
}

export type LinkFollowResult =
  /** External: a new tab, so the draft and its state are never lost. */
  | "opened"
  /** Internal: handed to the app's navigator, same pane. */
  | "navigated"
  /**
   * Nothing followed it. Either the href is not a target at all, or no
   * navigator is registered yet — the caller falls back to placing the caret
   * rather than swallowing the click.
   */
  | "unavailable";

export type OpenExternalLink = (url: string) => void;

const openInNewTab: OpenExternalLink = (url) => {
  window.open(url, "_blank", "noopener,noreferrer");
};

export function canFollowLink(
  target: LinkTarget | null,
  navigator: InternalLinkNavigator | null,
): boolean {
  if (!target) return false;
  return target.kind === "external" || navigator !== null;
}

export function followLink(
  target: LinkTarget | null,
  navigator: InternalLinkNavigator | null,
  open: OpenExternalLink = openInNewTab,
): LinkFollowResult {
  if (!target) return "unavailable";
  if (target.kind === "external") {
    open(target.url);
    return "opened";
  }
  if (!navigator) return "unavailable";
  navigator(target);
  return "navigated";
}
