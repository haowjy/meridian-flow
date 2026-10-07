/**
 * Where the focused change's bar sits. It never covers manuscript text, so it
 * has exactly two homes: the right margin beside the change, aligned with the
 * change's first line, or, when the margin is too narrow to hold it, a block of
 * its own after the paragraph the change ends in, which pushes the following
 * text down instead of overlapping it.
 *
 * Pure geometry in the manuscript overlay's coordinates (`manuscript-overlay`),
 * so it is testable without a browser.
 */
import type { OverlayBox } from "../../chrome/manuscript-overlay";

/** Air between the text column and the bar, and between the bar and the pane edge. */
export const BAR_GAP_PX = 12;
/** The bar wraps to two short rows; below this it would have to break its words. */
export const BAR_MIN_WIDTH_PX = 132;
/** Wider margins give the bar no more than its one-row width. */
export const BAR_MAX_WIDTH_PX = 260;

export type ReviewBarPlacement =
  | { kind: "margin"; top: number; left: number; maxWidth: number }
  | { kind: "below" };

export function placeReviewBar(input: {
  /** The change's first drawn element. Its top is the first line of the change. */
  anchor: OverlayBox;
  /** Right edge of the text column's content (padding excluded). */
  columnRight: number;
  /** Width of the scroll pane the manuscript is drawn in. */
  paneWidth: number;
}): ReviewBarPlacement {
  const left = input.columnRight + BAR_GAP_PX;
  const room = input.paneWidth - BAR_GAP_PX - left;
  if (room < BAR_MIN_WIDTH_PX) return { kind: "below" };
  return {
    kind: "margin",
    top: Math.max(0, input.anchor.top),
    left,
    maxWidth: Math.min(room, BAR_MAX_WIDTH_PX),
  };
}
