import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  pillBehaviorToDataAttributes,
  resolvePillBehavior,
} from "@/shared/reference-pill/behavior";
import { ReferencePill } from "@/shared/reference-pill/ReferencePill";

describe("reference pill behavior resolver", () => {
  it("defaults to non-interactive behavior", () => {
    expect(resolvePillBehavior()).toEqual({
      canNavigate: false,
      canRemove: false,
      hoverSwapIcon: false,
    });
  });

  it("enables hover icon swap by default when remove is enabled", () => {
    expect(resolvePillBehavior({ canRemove: true })).toEqual({
      canNavigate: false,
      canRemove: true,
      hoverSwapIcon: true,
    });
  });

  it("prevents hover swap when remove is disabled", () => {
    expect(
      resolvePillBehavior({
        canNavigate: true,
        canRemove: false,
        hoverSwapIcon: true,
      }),
    ).toEqual({
      canNavigate: true,
      canRemove: false,
      hoverSwapIcon: false,
    });
  });

  it("projects stable data attributes for CSS selectors", () => {
    const attrs = pillBehaviorToDataAttributes(
      resolvePillBehavior({
        canNavigate: true,
        canRemove: false,
      }),
    );
    expect(attrs).toEqual({
      "data-pill-navigable": "true",
      "data-pill-removable": "false",
      "data-pill-hover-swap": "false",
    });
  });
});

describe("ReferencePill rendering behavior", () => {
  it("keeps hover swap disabled for read-only pills", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReferencePill, {
        displayName: "Chapter 1",
        iconType: "file",
        onClick: () => {},
        // Even if requested, remove/swap stays off for this surface.
        behavior: { canRemove: true, hoverSwapIcon: true },
      }),
    );

    expect(html).toContain('data-pill-removable="false"');
    expect(html).toContain('data-pill-hover-swap="false"');
  });

  it("renders non-navigable state when onClick is absent", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReferencePill, {
        displayName: "Draft Outline",
        iconType: "file",
      }),
    );

    expect(html).toContain('data-pill-navigable="false"');
    expect(html).toContain("disabled");
  });
});
