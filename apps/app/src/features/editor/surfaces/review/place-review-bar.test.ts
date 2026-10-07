import { describe, expect, it } from "vitest";

import {
  BAR_EDGE_PX,
  BAR_GAP_PX,
  BAR_MAX_WIDTH_PX,
  BAR_MIN_WIDTH_PX,
  placeReviewBar,
} from "./place-review-bar";

const anchor = { left: 300, top: 210, right: 640, bottom: 260 };

describe("placeReviewBar", () => {
  it("takes the right margin, aligned with the change's first line, clear of the text column", () => {
    // 1280px window: 920px pane, text column content ends at 740px.
    const placement = placeReviewBar({ anchor, columnRight: 740, paneWidth: 920 });
    expect(placement.kind).toBe("margin");
    if (placement.kind !== "margin") return;
    expect(placement.top).toBe(anchor.top);
    expect(placement.left).toBeGreaterThanOrEqual(740 + BAR_GAP_PX);
    // Stays inside the pane, so nothing scrolls sideways.
    expect(placement.left + placement.maxWidth).toBeLessThanOrEqual(920 - BAR_EDGE_PX);
  });

  it("never grows past its one-row width in a wide margin", () => {
    const placement = placeReviewBar({ anchor, columnRight: 740, paneWidth: 1600 });
    expect(placement.kind === "margin" && placement.maxWidth).toBe(BAR_MAX_WIDTH_PX);
  });

  it("falls below the change when the margin cannot hold the bar", () => {
    // Pane 664px wide, column ends at 640px: 24px of margin.
    expect(placeReviewBar({ anchor, columnRight: 640, paneWidth: 664 }).kind).toBe("below");
    // Just under the minimum.
    const columnRight = 920 - BAR_EDGE_PX - BAR_GAP_PX - (BAR_MIN_WIDTH_PX - 1);
    expect(placeReviewBar({ anchor, columnRight, paneWidth: 920 }).kind).toBe("below");
    expect(placeReviewBar({ anchor, columnRight: columnRight - 1, paneWidth: 920 }).kind).toBe(
      "margin",
    );
  });

  it("keeps a change scrolled to the very top on the page", () => {
    const placement = placeReviewBar({
      anchor: { ...anchor, top: -3 },
      columnRight: 740,
      paneWidth: 920,
    });
    expect(placement.kind === "margin" && placement.top).toBe(0);
  });
});
