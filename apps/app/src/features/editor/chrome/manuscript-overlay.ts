/**
 * The layer measured chrome is drawn on, and the coordinates it is drawn in.
 *
 * Chrome that cannot be rendered inside the thing it decorates has to be
 * measured onto the page, and the SPACE it is measured into decides whether it
 * can ever come unstuck from that thing. Viewport coordinates cannot hold: the
 * pane scrolls and every fixed rect is wrong the instant it does, so the chrome
 * has to be re-measured, and a re-measurement is a frame behind the scroll that
 * caused it. Measured at one wheel notch a frame, a table's row grip was drawn
 * beside the row three below the one the pointer was on for every frame of a
 * scroll, and the block handle — which had no clip at all — was painted at the
 * top of the WINDOW, over the app's breadcrumb, while the manuscript went on
 * scrolling underneath it.
 *
 * So the space is the manuscript's own scroll pane. A box measured against the
 * pane's content origin does not change when the pane scrolls; the browser
 * moves the chrome with the content for free, and the pane's own overflow
 * clips whatever has left it. Nothing chases, and nothing can be painted
 * outside the editor, because the editor is the containing block.
 *
 * WHEN to re-measure is still `watchManuscriptLayout`'s answer — a block that
 * grows, a peer's write, an image arriving. Those change the number. A scroll
 * no longer does.
 */

import type { Editor } from "@tiptap/core";

/** A box in the overlay's coordinates. Never mix one with a viewport rect. */
export type OverlayBox = { left: number; top: number; right: number; bottom: number };

/**
 * The element measured chrome is portalled into, and whose coordinates it is
 * placed in: the manuscript's scroll pane.
 *
 * Resolved per render rather than remembered. It is a four-node walk, and an
 * element remembered across a remount of the editor's DOM is a portal into a
 * container nobody can see.
 */
export function manuscriptOverlay(editor: Editor | null): HTMLElement | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.view.dom.closest<HTMLElement>("[data-stable-layout-scroll]");
}

/**
 * `element`'s box in the overlay's coordinates, or null when nothing is
 * drawing it — a node view that remounted leaves the old element detached, and
 * a detached element measures as a zero box in the page's top-left corner.
 */
export function overlayRect(overlay: HTMLElement, element: Element): OverlayBox | null {
  if (!element.isConnected) return null;
  const box = element.getBoundingClientRect();
  // An absolutely positioned child is placed against the PADDING box, which is
  // where `clientLeft`/`clientTop` (the borders) come in, and `scrollLeft`/
  // `scrollTop` is how far the content has already travelled inside it.
  const pane = overlay.getBoundingClientRect();
  const originLeft = pane.left + overlay.clientLeft - overlay.scrollLeft;
  const originTop = pane.top + overlay.clientTop - overlay.scrollTop;
  return {
    left: box.left - originLeft,
    top: box.top - originTop,
    right: box.right - originLeft,
    bottom: box.bottom - originTop,
  };
}

/**
 * The part of the overlay the writer can see, in overlay coordinates.
 *
 * Not for placing anything — the pane's own clip does that, exactly and on the
 * frame the scroll lands. This answers the different question a surface asks
 * about its TARGET: is the thing I am aimed at still on screen, or has the
 * writer scrolled past it.
 */
export function overlayViewport(overlay: HTMLElement): OverlayBox {
  return {
    left: overlay.scrollLeft,
    top: overlay.scrollTop,
    right: overlay.scrollLeft + overlay.clientWidth,
    bottom: overlay.scrollTop + overlay.clientHeight,
  };
}
