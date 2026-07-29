/**
 * How big is this thing, really?
 *
 * The viewer measures its transform host's layout box, which means the caller
 * has to give that host a size — and the natural size of a rendered SVG is not
 * something CSS will tell you. Mermaid emits `width="100%"` with the real
 * dimensions in the `viewBox`, so a wrapper left to itself collapses to zero
 * and the diagram fits to nothing.
 *
 * Reading the `viewBox` answers it without touching the SVG, which is the
 * whole point of owning the viewer (svg-pan-zoom stripped the attribute to get
 * the same number).
 */

import type { ViewerSize } from "./viewer-math";

/**
 * The content's intrinsic size in CSS px, or null when the element has not
 * laid out and has no declared dimensions to fall back on.
 */
export function intrinsicContentSize(element: Element): ViewerSize | null {
  if (element instanceof SVGSVGElement) {
    const box = element.viewBox.baseVal;
    if (box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  }

  if (element instanceof HTMLImageElement && element.naturalWidth > 0) {
    return { width: element.naturalWidth, height: element.naturalHeight };
  }

  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };

  return null;
}
