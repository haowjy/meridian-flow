import type { LinkTarget } from "./link-target";

export type InternalLinkNavigator = (request: { target: LinkTarget; ref: string | null }) => void;

export type LinkClickIntent = { action: "place-caret" } | { action: "follow" };

export type LinkClickGesture = {
  button: number;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  swept: boolean;
};

export const MIDDLE_BUTTON = 1;

export function linkClickIntent({
  button,
  altKey,
  shiftKey,
  ctrlKey,
  metaKey,
  swept,
}: LinkClickGesture): LinkClickIntent {
  // The middle button places nothing anywhere, so none of the caret rules
  // below can apply to it. The app opens a followed link in one place, so it follows like a click.
  if (button === MIDDLE_BUTTON) return { action: "follow" };

  if (altKey) return { action: "place-caret" };
  if (shiftKey) return { action: "place-caret" };
  // A sweep that started and ended on the same link is a selection, not a
  // follow: the writer was highlighting text to read it or point at it (law 7).
  if (swept) return { action: "place-caret" };

  // Ctrl on Windows and Linux, Cmd on macOS. Taking both is safe: macOS turns
  // Ctrl+click into a context menu before it can become a click, and the claim
  // ladder has already answered that one.
  if (ctrlKey || metaKey) return { action: "follow" };

  return { action: "follow" };
}

export type LinkFollowResult = "opened" | "navigated" | "unavailable";

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

export type LinkFollowRequest = {
  target: LinkTarget | null;
  ref: string | null;
};

export function followLink(
  { target, ref }: LinkFollowRequest,
  navigator: InternalLinkNavigator | null,
  open: OpenExternalLink = openInNewTab,
): LinkFollowResult {
  if (!target) return "unavailable";
  if (target.kind === "external") {
    open(target.url);
    return "opened";
  }
  if (!navigator) return "unavailable";
  navigator({ target, ref });
  return "navigated";
}
