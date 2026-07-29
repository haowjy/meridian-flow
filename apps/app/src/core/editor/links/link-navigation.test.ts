import { describe, expect, it, vi } from "vitest";

import { canFollowLink, followLink, linkClickAction } from "./link-navigation";
import type { LinkTarget } from "./link-target";

describe("linkClickAction", () => {
  it.each([
    ["a plain click follows", { altKey: false, travelledPx: 0 }, "follow"],
    ["a click with a pixel of jitter still follows", { altKey: false, travelledPx: 3 }, "follow"],
    ["Alt places the caret instead", { altKey: true, travelledPx: 0 }, "place-caret"],
    ["a drag past the slop is a selection", { altKey: false, travelledPx: 4 }, "place-caret"],
    ["a long sweep is a selection", { altKey: false, travelledPx: 90 }, "place-caret"],
    ["Alt wins over everything", { altKey: true, travelledPx: 90 }, "place-caret"],
  ])("%s", (_name, gesture, expected) => {
    expect(linkClickAction(gesture)).toBe(expected);
  });
});

const external: LinkTarget = { kind: "external", url: "https://example.com" };
const wikilink: LinkTarget = { kind: "wikilink", name: "The Second Gate" };

describe("followLink", () => {
  it("opens an external link in a new tab so the draft is never lost", () => {
    const open = vi.fn();

    expect(followLink(external, null, open)).toBe("opened");
    expect(open).toHaveBeenCalledWith("https://example.com");
  });

  it("hands an internal link to the app's navigator", () => {
    const navigate = vi.fn();

    expect(followLink(wikilink, navigate)).toBe("navigated");
    expect(navigate).toHaveBeenCalledWith(wikilink);
  });

  it("reports an internal link as unfollowable until a navigator is registered", () => {
    expect(followLink(wikilink, null)).toBe("unavailable");
    expect(canFollowLink(wikilink, null)).toBe(false);
    expect(canFollowLink(external, null)).toBe(true);
  });

  it("never invents a destination for an href it could not classify", () => {
    const open = vi.fn();

    expect(followLink(null, null, open)).toBe("unavailable");
    expect(canFollowLink(null, () => {})).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
