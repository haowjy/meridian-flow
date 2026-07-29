/**
 * The viewer's arithmetic: fit, center, zoom-at-a-point, and the two-pointer
 * span a pinch is made of.
 *
 * Pure and DOM-free, so every claim the viewer makes about where a diagram
 * lands can be tested as a table instead of driven through a browser. The
 * module beside it owns pointers, listeners, and the one `style.transform`
 * write.
 *
 * **Coordinates.** A point handed to `zoomAtPoint` is HOST-RELATIVE — client
 * coordinates minus the host's `getBoundingClientRect()`. That subtraction is
 * exactly what svg-pan-zoom's own pinch demo omitted, which put the anchor
 * 257 px off for any viewer that is not at the page origin (a dialog always
 * is). Spelled here so a caller has one convention to get right.
 *
 * The transform is `translate(pan) scale(scale)` with the origin at the
 * content's top-left, so a content point `c` lands on screen at
 * `pan + c * scale`. Everything below is that one equation solved for
 * whichever end is known.
 */

export type ViewerPoint = { x: number; y: number };
export type ViewerSize = { width: number; height: number };
export type ViewerTransform = { scale: number; pan: ViewerPoint };
export type ViewerScaleLimits = { minScale: number; maxScale: number };

export function clampScale(scale: number, { minScale, maxScale }: ViewerScaleLimits): number {
  return Math.min(Math.max(scale, minScale), maxScale);
}

/**
 * The scale at which `content` fits inside `host`, contained rather than
 * cropped, with `padding` px kept clear on every side.
 *
 * Degenerate content (a diagram measured before it laid out) fits at 1 rather
 * than at infinity: a viewer that opens at the identity transform reads as
 * "not ready yet", one that opens at 1e9 reads as broken.
 */
export function fitScale(host: ViewerSize, content: ViewerSize, padding = 0): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  const width = Math.max(host.width - padding * 2, 1);
  const height = Math.max(host.height - padding * 2, 1);
  return Math.min(width / content.width, height / content.height);
}

/** The pan that centers `content` at `scale` inside `host`. */
export function centerPan(host: ViewerSize, content: ViewerSize, scale: number): ViewerPoint {
  return {
    x: (host.width - content.width * scale) / 2,
    y: (host.height - content.height * scale) / 2,
  };
}

/**
 * Fit and center in one reading — what the viewer takes on mount, on Fit, and
 * whenever the host changes shape under an untouched diagram.
 *
 * Clamping the fit is what keeps a wall-sized diagram reachable: the limits a
 * caller passes are absolute, and a fit below `minScale` would otherwise be
 * refused by the very rule meant to stop the writer zooming into nothing.
 */
export function fitTransform(
  host: ViewerSize,
  content: ViewerSize,
  { padding = 0, limits }: { padding?: number; limits?: ViewerScaleLimits } = {},
): ViewerTransform {
  const fitted = fitScale(host, content, padding);
  const scale = limits ? clampScale(fitted, limits) : fitted;
  return { scale, pan: centerPan(host, content, scale) };
}

/** The content coordinate currently under a host-relative point. */
export function contentPointAt(transform: ViewerTransform, at: ViewerPoint): ViewerPoint {
  return {
    x: (at.x - transform.pan.x) / transform.scale,
    y: (at.y - transform.pan.y) / transform.scale,
  };
}

/**
 * Zoom to `scale` while the content point under `at` stays under `at`.
 *
 * This is the whole reason wheel zoom feels like a map instead of a slider:
 * the writer points at a node and the node does not move.
 */
export function zoomAtPoint(
  transform: ViewerTransform,
  scale: number,
  at: ViewerPoint,
): ViewerTransform {
  const anchor = contentPointAt(transform, at);
  return {
    scale,
    pan: { x: at.x - anchor.x * scale, y: at.y - anchor.y * scale },
  };
}

export function panTransformBy(transform: ViewerTransform, delta: ViewerPoint): ViewerTransform {
  return {
    scale: transform.scale,
    pan: { x: transform.pan.x + delta.x, y: transform.pan.y + delta.y },
  };
}

/**
 * What a set of live pointers means: where they are together, and how far
 * apart. One pointer is a drag, so its span has no spread; two or more are a
 * pinch, and the ratio of successive spreads IS the zoom factor.
 */
export type PointerSpan = { centroid: ViewerPoint; spread: number };

export function pointerSpan(points: readonly ViewerPoint[]): PointerSpan | null {
  if (points.length === 0) return null;

  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  const centroid = { x: sumX / points.length, y: sumY / points.length };

  if (points.length < 2) return { centroid, spread: 0 };

  // Mean distance from the centroid rather than the first-to-second distance:
  // a third finger landing mid-pinch then shifts the scale smoothly instead of
  // redefining which two fingers count.
  let total = 0;
  for (const point of points) {
    total += Math.hypot(point.x - centroid.x, point.y - centroid.y);
  }
  return { centroid, spread: total / points.length };
}

/**
 * The zoom factor and pan a pinch asks for between two samples of the same
 * pointer set.
 *
 * A spread that was zero (or has become zero) means the gesture is not a
 * pinch, so it contributes movement only — which is what makes a second finger
 * landing on a drag continue the drag rather than snapping the scale.
 */
export function pinchStep(
  previous: PointerSpan,
  next: PointerSpan,
): { factor: number; delta: ViewerPoint } {
  const factor = previous.spread > 0 && next.spread > 0 ? next.spread / previous.spread : 1;
  return {
    factor,
    delta: {
      x: next.centroid.x - previous.centroid.x,
      y: next.centroid.y - previous.centroid.y,
    },
  };
}

/** Rough line and page heights for wheel deltas reported in lines or pages. */
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 400;

/**
 * A wheel notch as a scale factor.
 *
 * Exponential, so zooming out by n notches and back in by n lands exactly
 * where it started — a linear step does not, and the drift shows up as a
 * diagram that creeps every time the writer changes their mind. A trackpad
 * emits many small deltas and a mouse a few large ones; both go through the
 * same curve, and the per-event clamp keeps one violent notch from crossing
 * the whole zoom range.
 */
export function wheelScaleFactor(deltaY: number, deltaMode = 0, sensitivity = 0.0015): number {
  const pixels =
    deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaMode === 2 ? deltaY * WHEEL_PAGE_PX : deltaY;
  const clamped = Math.max(-200, Math.min(200, pixels));
  return Math.exp(-clamped * sensitivity);
}
