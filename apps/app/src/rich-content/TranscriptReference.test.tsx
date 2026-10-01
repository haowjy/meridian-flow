// @vitest-environment jsdom
/** How a syntax link in a transcript reaches the surface's follower. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LinkTarget } from "@/core/editor/links";

import {
  type TranscriptLinkNavigation,
  TranscriptLinkNavigationContext,
  TranscriptReference,
} from "./TranscriptReference";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root;
let host: HTMLDivElement;
let follow: ReturnType<typeof vi.fn<(target: LinkTarget) => void>>;
let navigation: TranscriptLinkNavigation;

beforeEach(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // Chat's rule: no base URI, so a relative path can never be followed.
  follow = vi.fn<(target: LinkTarget) => void>();
  navigation = {
    follow,
    canFollow: (target: LinkTarget) => target.kind !== "relative",
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(href: string, label: string) {
  act(() =>
    root.render(
      <TranscriptLinkNavigationContext.Provider value={navigation}>
        <TranscriptReference data-target-href={href}>{label}</TranscriptReference>
      </TranscriptLinkNavigationContext.Provider>,
    ),
  );
  const element = [...host.querySelectorAll("span")].find((span) => span.textContent === label);
  if (!element) throw new Error(`no reference labelled ${label}`);
  return element;
}

describe("TranscriptReference", () => {
  it("hands a syntax wikilink to the surface's follower", () => {
    const reference = render("[[Kael]]", "Kael");

    expect(reference.getAttribute("role")).toBe("link");
    act(() => reference.click());

    expect(follow).toHaveBeenCalledWith({ kind: "wikilink", name: "Kael" });
  });

  it("renders a link the surface can never follow as plain text with its href", () => {
    const reference = render("./cast.md", "the cast");

    expect(reference.getAttribute("role")).toBeNull();
    expect(reference.hasAttribute("tabindex")).toBe(false);
    expect(reference.getAttribute("title")).toBe("./cast.md");
    act(() => reference.click());
    expect(follow).not.toHaveBeenCalled();
  });
});
