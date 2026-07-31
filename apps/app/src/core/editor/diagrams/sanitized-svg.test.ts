// @vitest-environment jsdom
/**
 * The rendering boundary, tested from both sides.
 *
 * What it must drop is anything in a "diagram" that acts: a script, an event
 * handler, a `javascript:` door, HTML smuggled in through `<foreignObject>`.
 * What it must keep is everything a real diagram is drawn with, because a
 * boundary that erases the picture is a boundary the next lane routes around.
 *
 * The other half of the contract is a compile fact rather than an assertion:
 * only `sanitizeSvg` produces a `SanitizedSvg`, so the `@ts-expect-error` below
 * fails the typecheck if a raw string ever becomes assignable to a consumer
 * that inserts markup.
 */
import { describe, expect, it } from "vitest";

import { type SanitizedSvg, sanitizeSvg } from "./sanitized-svg";

/** Stands in for the two faces: both take markup this type says was checked. */
function insertMarkup(markup: SanitizedSvg): string {
  return markup;
}

describe("sanitizeSvg", () => {
  it("drops a script a provider left in the markup", () => {
    const clean = sanitizeSvg(
      '<svg><script>globalThis.stolen = 1</script><rect width="10" height="10"/></svg>',
    );

    expect(clean).not.toContain("script");
    expect(clean).toContain("<rect");
  });

  it("drops event handlers and javascript: doors", () => {
    const clean = sanitizeSvg(
      '<svg onload="globalThis.stolen = 1">' +
        '<rect onclick="globalThis.stolen = 2" width="10" height="10"/>' +
        '<a href="javascript:globalThis.stolen = 3"><text>label</text></a>' +
        "</svg>",
    );

    expect(clean).not.toContain("onload");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("javascript:");
    expect(clean).toContain("label");
  });

  it("drops a foreignObject and the HTML inside it", () => {
    const clean = sanitizeSvg(
      "<svg><foreignObject>" +
        '<div xmlns="http://www.w3.org/1999/xhtml">' +
        '<iframe src="https://example.test"></iframe><img src="x" onerror="globalThis.stolen = 1">' +
        "</div></foreignObject></svg>",
    );

    expect(clean).not.toContain("foreignObject");
    expect(clean).not.toContain("iframe");
    expect(clean).not.toContain("onerror");
  });

  it("keeps what a rendered diagram is actually drawn with", () => {
    // The shape of mermaid's own output: its theme stylesheet, the arrow marker
    // its links reference by id, and a text label positioned on a baseline.
    const clean = sanitizeSvg(
      '<svg id="d1" viewBox="0 0 200 100" role="graphics-document document" aria-roledescription="flowchart-v2">' +
        "<style>#d1 .node rect{fill:#fff}</style>" +
        '<marker id="d1_arrow" markerWidth="8" orient="auto"><path d="M0,0 L8,4 L0,8"/></marker>' +
        '<g class="node" transform="translate(10,10)"><rect width="60" height="30" style="fill:#eee" rx="5"/>' +
        '<text text-anchor="middle" dominant-baseline="middle"><tspan x="5" dy="0">Start</tspan></text></g>' +
        '<path d="M0,0L10,10" marker-end="url(#d1_arrow)" class="flowchart-link"/>' +
        "</svg>",
    );

    expect(clean).toContain("<style>");
    expect(clean).toContain('id="d1_arrow"');
    expect(clean).toContain("url(#d1_arrow)");
    expect(clean).toContain('dominant-baseline="middle"');
    expect(clean).toContain('role="graphics-document document"');
    expect(clean).toContain("aria-roledescription");
    expect(clean).toContain("Start");
  });

  it("is the only way to reach a consumer that inserts markup", () => {
    const raw = "<svg><rect /></svg>";

    // @ts-expect-error a provider's raw string is not sanitized markup
    insertMarkup(raw);

    expect(insertMarkup(sanitizeSvg(raw))).toContain("<rect");
  });
});
