import { describe, expect, it, vi } from "vitest";

import { canFollowLink, followLink, linkClickIntent } from "./link-navigation";
import type { LinkTarget } from "./link-target";

const press = {
  button: 0,
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  travelledPx: 0,
};

describe("linkClickIntent", () => {
  it.each([
    ["a plain click follows in place", press, { action: "follow", disposition: "current" }],
    [
      "a pixel of jitter is still a click",
      { ...press, travelledPx: 3 },
      { action: "follow", disposition: "current" },
    ],
    ["Alt asks for the caret instead", { ...press, altKey: true }, { action: "place-caret" }],
    [
      "Shift extends a selection, which is the editor's gesture",
      { ...press, shiftKey: true },
      { action: "place-caret" },
    ],
    [
      "a drag past the slop is a selection",
      { ...press, travelledPx: 4 },
      { action: "place-caret" },
    ],
    [
      "Ctrl means a new tab, as it does everywhere else",
      { ...press, ctrlKey: true },
      { action: "follow", disposition: "new-tab" },
    ],
    ["so does Cmd", { ...press, metaKey: true }, { action: "follow", disposition: "new-tab" }],
    [
      "the middle button is a new tab and never a caret",
      { ...press, button: 1 },
      { action: "follow", disposition: "new-tab" },
    ],
    [
      "a middle button that travelled is still a follow, because it places nothing",
      { ...press, button: 1, travelledPx: 90 },
      { action: "follow", disposition: "new-tab" },
    ],
    [
      "Alt beats the new-tab modifiers: the writer asked for the caret",
      { ...press, altKey: true, ctrlKey: true },
      { action: "place-caret" },
    ],
    [
      "a Ctrl-drag is still a drag",
      { ...press, ctrlKey: true, travelledPx: 40 },
      { action: "place-caret" },
    ],
  ])("%s", (_name, gesture, expected) => {
    expect(linkClickIntent(gesture)).toEqual(expected);
  });
});

const external: LinkTarget = { kind: "external", url: "https://example.com/" };
const wikilink: LinkTarget = { kind: "wikilink", name: "The Second Gate" };

describe("followLink", () => {
  it("opens an external link in a new tab so the draft is never lost", () => {
    const open = vi.fn();

    expect(followLink({ target: external, disposition: "current" }, null, open)).toBe("opened");
    expect(open).toHaveBeenCalledWith("https://example.com/");
  });

  it("hands an internal link to the app's navigator, disposition and all", () => {
    const navigate = vi.fn();

    expect(followLink({ target: wikilink, disposition: "new-tab" }, navigate)).toBe("navigated");
    expect(navigate).toHaveBeenCalledWith({ target: wikilink, disposition: "new-tab" });
  });

  it("reports an internal link as unfollowable until a navigator is registered", () => {
    expect(followLink({ target: wikilink, disposition: "current" }, null)).toBe("unavailable");
    expect(canFollowLink(wikilink, null)).toBe(false);
    expect(canFollowLink(external, null)).toBe(true);
  });

  it("never invents a destination for an href it could not classify", () => {
    const open = vi.fn();

    expect(followLink({ target: null, disposition: "current" }, null, open)).toBe("unavailable");
    expect(canFollowLink(null, () => {})).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
