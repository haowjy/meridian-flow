import type { Editor } from "@tiptap/core";

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

export function overlayToViewport(
  overlay: HTMLElement,
  at: { left: number; top: number },
): { x: number; y: number } {
  const pane = overlay.getBoundingClientRect();
  return {
    x: pane.left + overlay.clientLeft - overlay.scrollLeft + at.left,
    y: pane.top + overlay.clientTop - overlay.scrollTop + at.top,
  };
}

export function overlayViewport(overlay: HTMLElement): OverlayBox {
  return {
    left: overlay.scrollLeft,
    top: overlay.scrollTop,
    right: overlay.scrollLeft + overlay.clientWidth,
    bottom: overlay.scrollTop + overlay.clientHeight,
  };
}
