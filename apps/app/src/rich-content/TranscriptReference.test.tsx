// @vitest-environment jsdom
/**
 * How a transcript reference reaches the surface's follower, and which chip it
 * draws from the surface's own resolution cache.
 */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLinkRequester,
  createLinkResolution,
  type LinkResolution,
  type LinkTarget,
} from "@/core/editor/links";

import {
  type TranscriptLinkNavigation,
  TranscriptLinkNavigationContext,
  TranscriptReference,
  TranscriptReferenceContext,
  type TranscriptReferenceResolution,
} from "./TranscriptReference";

const KB_KAEL: ResolvedDocumentLink = {
  documentId: "doc-kael",
  title: "Kael",
  scheme: "kb",
  path: "characters/Kael.md",
  uri: "kb://characters/Kael.md",
  workId: null,
};

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root;
let host: HTMLDivElement;
let follow: ReturnType<typeof vi.fn<(target: LinkTarget) => void>>;
let resolution: LinkResolution;
let navigation: TranscriptLinkNavigation;

beforeEach(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  follow = vi.fn<(target: LinkTarget) => void>();
  resolution = createLinkResolution();
  // Chat's rule: no base URI, so a relative path can never be followed.
  navigation = {
    follow,
    canFollow: (target: LinkTarget) => target.kind !== "relative",
    resolution,
    watch: createLinkRequester(resolution).watch,
  };
});

afterEach(() => {
  act(() => root.unmount());
  resolution.destroy();
  host.remove();
});

function find(label: string): HTMLSpanElement {
  const element = [...host.querySelectorAll("span")].find((span) => span.textContent === label);
  if (!element) throw new Error(`no reference labelled ${label}`);
  return element;
}

function render(href: string, label: string) {
  act(() =>
    root.render(
      <TranscriptLinkNavigationContext.Provider value={navigation}>
        <TranscriptReference data-target-href={href}>{label}</TranscriptReference>
      </TranscriptLinkNavigationContext.Provider>,
    ),
  );
  return find(label);
}

function renderExact(resolved: TranscriptReferenceResolution, uri: string, label: string) {
  act(() =>
    root.render(
      <TranscriptReferenceContext.Provider
        value={{ resolutions: new Map([[resolved.documentId, resolved]]), onOpen: vi.fn() }}
      >
        <TranscriptReference data-document-id={resolved.documentId} data-uri={uri}>
          {label}
        </TranscriptReference>
      </TranscriptReferenceContext.Provider>,
    ),
  );
  return find(label);
}

function chip(element: HTMLElement) {
  return {
    state: element.getAttribute("data-link-chip"),
    icon: element.getAttribute("data-link-chip-icon"),
  };
}

/** Lets queued questions settle and the microtask re-ask run. */
async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
}

describe("TranscriptReference", () => {
  it("hands a Context URI link to the surface's follower", () => {
    const reference = render("kb://characters/Kael.md", "Kael");

    expect(reference.getAttribute("role")).toBe("link");
    act(() => reference.click());

    expect(follow).toHaveBeenCalledWith({ kind: "scheme", uri: "kb://characters/Kael.md" });
  });

  it("renders a link the surface can never follow as plain text with its href", () => {
    const reference = render("./cast.md", "the cast");

    expect(reference.getAttribute("role")).toBeNull();
    expect(reference.hasAttribute("tabindex")).toBe(false);
    expect(reference.hasAttribute("data-link-chip")).toBe(false);
    expect(reference.getAttribute("title")).toBe("./cast.md");
    act(() => reference.click());
    expect(follow).not.toHaveBeenCalled();
  });

  it("draws a resolved link in the family of the document it found", async () => {
    resolution.registerResolver(async () => KB_KAEL);
    const reference = render("manuscript://Kael.md", "Kael");
    await settle();

    expect(chip(reference)).toEqual({ state: "filled", icon: "kb" });
  });

  it("dashes an address nothing is at yet, in its own family, and still follows it", async () => {
    resolution.registerResolver(async () => null);
    const reference = render("kb://characters/Ilsever.md", "Ilsever");
    await settle();

    expect(chip(reference)).toEqual({ state: "dashed", icon: "kb" });
    expect(reference.getAttribute("aria-disabled")).toBe("false");
    expect(reference.getAttribute("aria-description")).toBe("No document at that address");
  });

  it("shows an address's family while it is still being asked", async () => {
    resolution.registerResolver(() => new Promise(() => {}));
    const reference = render("scratch://@revision-pass/notes.md", "notes");
    await settle();

    expect(chip(reference)).toEqual({ state: "filled", icon: "scratch" });
  });

  it("asks again when the scope registers a new generation", async () => {
    resolution.registerResolver(async () => null);
    const reference = render("kb://characters/Kael.md", "Kael");
    await settle();
    expect(chip(reference).state).toBe("dashed");

    // A created document is a new catalog, so the chat registers again.
    act(() => {
      resolution.registerResolver(async () => KB_KAEL);
    });
    await settle();

    expect(chip(reference)).toEqual({ state: "filled", icon: "kb" });
  });

  it("asks once per href and settles under StrictMode's double mount", async () => {
    const resolver = vi.fn(async () => KB_KAEL);
    resolution.registerResolver(resolver);
    act(() =>
      root.render(
        <StrictMode>
          <TranscriptLinkNavigationContext.Provider value={navigation}>
            <TranscriptReference data-target-href="kb://characters/Kael.md">
              Kael
            </TranscriptReference>
            <TranscriptReference data-target-href="kb://characters/Kael.md">
              the warden
            </TranscriptReference>
          </TranscriptLinkNavigationContext.Provider>
        </StrictMode>,
      ),
    );
    await settle();

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(chip(find("Kael"))).toEqual({ state: "filled", icon: "kb" });
    expect(chip(find("the warden"))).toEqual({ state: "filled", icon: "kb" });

    // The double effect unwatched and watched again; the requester must still
    // be listening, so a new generation is asked, once.
    const next = vi.fn(async () => null);
    act(() => {
      resolution.registerResolver(next);
    });
    await settle();

    expect(next).toHaveBeenCalledTimes(1);
    expect(chip(find("Kael")).state).toBe("dashed");
  });

  it("dashes an exact reference whose document is gone, and does not follow it", () => {
    const reference = renderExact(
      { documentId: "doc-map", available: false },
      "uploads://@/map.png",
      "map.png",
    );

    expect(chip(reference)).toEqual({ state: "dashed", icon: "uploads" });
    expect(reference.getAttribute("aria-disabled")).toBe("true");
    expect(reference.getAttribute("aria-description")).toBe("No document at that address");
  });

  it("keeps a moved document filled and unfollowed at the URI the writer referenced", () => {
    const reference = renderExact(
      { documentId: "doc-style", uri: "kb://style.md", label: "style", available: true },
      "user://style.md",
      "style",
    );

    expect(chip(reference)).toEqual({ state: "filled", icon: "user" });
    expect(reference.getAttribute("aria-disabled")).toBe("true");
  });

  it("names an exact reference's family by its URI", () => {
    const reference = renderExact(
      { documentId: "doc-style", uri: "user://style.md", label: "style", available: true },
      "user://style.md",
      "style",
    );

    expect(chip(reference)).toEqual({ state: "filled", icon: "user" });
    expect(reference.getAttribute("aria-disabled")).toBe("false");
  });
});
