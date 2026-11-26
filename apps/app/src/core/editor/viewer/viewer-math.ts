export type ViewerPoint = { x: number; y: number };
export type ViewerSize = { width: number; height: number };
export type ViewerTransform = { scale: number; pan: ViewerPoint };
export type ViewerScaleLimits = { minScale: number; maxScale: number };

export function clampScale(scale: number, { minScale, maxScale }: ViewerScaleLimits): number {
  return Math.min(Math.max(scale, minScale), maxScale);
}

export function fitScale(host: ViewerSize, content: ViewerSize, padding = 0): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  const width = Math.max(host.width - padding * 2, 1);
  const height = Math.max(host.height - padding * 2, 1);
  return Math.min(width / content.width, height / content.height);
}

export function centerPan(host: ViewerSize, content: ViewerSize, scale: number): ViewerPoint {
  return {
    x: (host.width - content.width * scale) / 2,
    y: (host.height - content.height * scale) / 2,
  };
}

export function fitTransform(
  host: ViewerSize,
  content: ViewerSize,
  { padding = 0, limits }: { padding?: number; limits?: ViewerScaleLimits } = {},
): ViewerTransform {
  const fitted = fitScale(host, content, padding);
  const scale = limits ? clampScale(fitted, limits) : fitted;
  return { scale, pan: centerPan(host, content, scale) };
}

export function contentPointAt(transform: ViewerTransform, at: ViewerPoint): ViewerPoint {
  return {
    x: (at.x - transform.pan.x) / transform.scale,
    y: (at.y - transform.pan.y) / transform.scale,
  };
}

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

const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 400;

export function wheelScaleFactor(deltaY: number, deltaMode = 0, sensitivity = 0.0015): number {
  const pixels =
    deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaMode === 2 ? deltaY * WHEEL_PAGE_PX : deltaY;
  const clamped = Math.max(-200, Math.min(200, pixels));
  return Math.exp(-clamped * sensitivity);
}
