/**
 * viewer-core — pan and zoom over any element, on one PointerEvent code path.
 *
 * Mouse, touch, and pen are the same gesture stream here: `pointerdown` with
 * one live pointer is a drag, with two it is a pinch, and neither branch knows
 * which device it is serving. That single path is why this file is short —
 * it is also the thing svg-pan-zoom cannot do, being touch-events-only and
 * older than Pointer Events (spike verdict, 2026-07-29).
 *
 * **Transform-only, on a host we own.** The viewer writes exactly one
 * property, `content.style.transform`, and never touches the element inside —
 * no `viewBox` rewrite, no DOM restructure, so a rendered SVG stays byte-exact
 * for copy, download, and re-measure. The caller wraps its content in the
 * transform host and gives it a size; the viewer measures that host's layout
 * box (`offsetWidth`, which a transform does not affect) and moves it.
 *
 * **Writes are rAF-throttled; reads are not.** Every getter answers from state
 * synchronously, so a caller never has to know a frame is pending. Only the
 * DOM write waits.
 *
 * View state is deliberately DISPOSABLE (decision 2026-07-29): nothing here
 * persists, and a viewer that is destroyed and rebuilt opens fitted. There is
 * no restore path to keep honest.
 */

import {
  clampScale,
  fitScale,
  fitTransform,
  type PointerSpan,
  panTransformBy,
  pinchStep,
  pointerSpan,
  type ViewerPoint,
  type ViewerSize,
  type ViewerTransform,
  wheelScaleFactor,
  zoomAtPoint,
} from "./viewer-math";

export type PanZoomViewerOptions = {
  /** The clipping viewport. Gesture listeners bind here. */
  host: HTMLElement;
  /**
   * The transform host: the caller's own wrapper around the content, sized to
   * the content's intrinsic dimensions. Never the content itself, so nothing
   * the viewer does can be mistaken for an edit to what is being viewed.
   */
  content: HTMLElement;
  /** Absolute scale floor. Lowered to the fit scale when a diagram is huge. */
  minScale?: number;
  maxScale?: number;
  /** Clear space kept around the content when fitting. */
  padding?: number;
  /** Factor for one double-click or one zoom button press. */
  stepFactor?: number;
  /** Fires after any change to scale or pan, before the DOM write. */
  onChange?: () => void;
};

export type ViewerSizes = {
  /** The host's viewport, CSS px. */
  host: ViewerSize;
  /** The content's untransformed layout box, CSS px. */
  content: ViewerSize;
  /** The scale at which the content would fit — what Fit lands on. */
  fitScale: number;
  /** The scale actually applied right now. */
  realZoom: number;
};

export type PanZoomViewer = {
  /** Applied scale. 1 means the content is at its intrinsic size. */
  readonly scale: number;
  readonly pan: ViewerPoint;
  /** True until a gesture moves the view away from its fit. */
  readonly fitted: boolean;
  sizes(): ViewerSizes;
  /** `at` is host-relative; omitted means the host's center. */
  zoomBy(factor: number, at?: ViewerPoint): void;
  zoomTo(scale: number, at?: ViewerPoint): void;
  panBy(delta: ViewerPoint): void;
  /** Fit and center. Also the mount state, and what Fit restores. */
  fit(): void;
  /**
   * Re-measure. An untouched view refits; a view the writer has moved keeps
   * its transform, because a window resize is not a request to lose your place.
   */
  resize(): void;
  subscribe(listener: () => void): () => void;
  destroy(): void;
};

const DEFAULTS = {
  minScale: 0.1,
  maxScale: 8,
  padding: 24,
  stepFactor: 1.6,
} as const;

export function createPanZoomViewer({
  host,
  content,
  minScale = DEFAULTS.minScale,
  maxScale = DEFAULTS.maxScale,
  padding = DEFAULTS.padding,
  stepFactor = DEFAULTS.stepFactor,
  onChange,
}: PanZoomViewerOptions): PanZoomViewer {
  const listeners = new Set<() => void>();
  const pointers = new Map<number, ViewerPoint>();

  let transform: ViewerTransform = { scale: 1, pan: { x: 0, y: 0 } };
  let fitted = true;
  let span: PointerSpan | null = null;
  let frame = 0;
  let destroyed = false;

  content.style.transformOrigin = "0 0";
  content.style.willChange = "transform";

  const hostSize = (): ViewerSize => ({ width: host.clientWidth, height: host.clientHeight });
  const contentSize = (): ViewerSize => ({
    width: content.offsetWidth,
    height: content.offsetHeight,
  });

  /** Absolute limits, floored at the fit so a wall-sized diagram still fits. */
  const limits = () => ({
    minScale: Math.min(minScale, fitScale(hostSize(), contentSize(), padding)),
    maxScale,
  });

  const write = () => {
    frame = 0;
    content.style.transform = `translate(${transform.pan.x}px, ${transform.pan.y}px) scale(${transform.scale})`;
  };

  const commit = (next: ViewerTransform, { keepsFit = false } = {}) => {
    if (
      next.scale === transform.scale &&
      next.pan.x === transform.pan.x &&
      next.pan.y === transform.pan.y
    ) {
      return;
    }
    transform = next;
    if (!keepsFit) fitted = false;
    // Writes coalesce to one per frame; readers never wait for it.
    if (frame === 0) frame = requestAnimationFrame(write);
    onChange?.();
    for (const listener of listeners) listener();
  };

  const hostPoint = (event: { clientX: number; clientY: number }): ViewerPoint => {
    const box = host.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const hostCenter = (): ViewerPoint => {
    const size = hostSize();
    return { x: size.width / 2, y: size.height / 2 };
  };

  const zoomTo = (scale: number, at?: ViewerPoint) => {
    const clamped = clampScale(scale, limits());
    if (clamped === transform.scale) return;
    commit(zoomAtPoint(transform, clamped, at ?? hostCenter()));
  };

  const fit = () => {
    fitted = true;
    commit(fitTransform(hostSize(), contentSize(), { padding, limits: limits() }), {
      keepsFit: true,
    });
  };

  // ── gestures ────────────────────────────────────────────────────────────

  const onPointerDown = (event: PointerEvent) => {
    // Mouse right/middle belong to the context menu and the browser.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Owning the gesture means owning the selection it would otherwise start:
    // drag pans (§5.2), so a native text drag inside a label must not begin.
    event.preventDefault();
    host.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, hostPoint(event));
    span = pointerSpan([...pointers.values()]);
    host.dataset.panning = "";
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, hostPoint(event));

    const next = pointerSpan([...pointers.values()]);
    if (!next || !span) return;

    // One equation for both gestures: the centroid's travel is the pan, the
    // spread's ratio is the zoom. With one pointer the ratio is 1 and this is
    // a drag; the branch never has to exist.
    const { factor, delta } = pinchStep(span, next);
    const moved = panTransformBy(transform, delta);
    span = next;
    commit(
      factor === 1
        ? moved
        : zoomAtPoint(moved, clampScale(moved.scale * factor, limits()), next.centroid),
    );
  };

  const endPointer = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    // Re-baseline: lifting one finger of a pinch must continue the drag from
    // where the remaining finger is, not jump by the centroid's shift.
    span = pointerSpan([...pointers.values()]);
    if (pointers.size === 0) delete host.dataset.panning;
  };

  const onWheel = (event: WheelEvent) => {
    // Non-passive on purpose: without the default the page behind the dialog
    // scrolls under the diagram.
    event.preventDefault();
    zoomTo(transform.scale * wheelScaleFactor(event.deltaY, event.deltaMode), hostPoint(event));
  };

  const onDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    zoomTo(transform.scale * stepFactor, hostPoint(event));
  };

  // A context menu inside the viewer is the browser's, not a gesture: release
  // the capture so the pointer does not stay stuck mid-pan behind the menu.
  const onContextMenu = () => {
    for (const id of pointers.keys()) {
      if (host.hasPointerCapture(id)) host.releasePointerCapture(id);
    }
    pointers.clear();
    span = null;
    delete host.dataset.panning;
  };

  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", endPointer);
  host.addEventListener("pointercancel", endPointer);
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("dblclick", onDoubleClick);
  host.addEventListener("contextmenu", onContextMenu);

  // A view the writer has moved keeps its transform: a window resize, a source
  // pane opening, or a re-render is not a request to lose your place. Only an
  // untouched view follows the new shape.
  const resize = () => {
    if (!destroyed && fitted) fit();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(host);
  observer.observe(content);

  fit();

  return {
    get scale() {
      return transform.scale;
    },
    get pan() {
      return transform.pan;
    },
    get fitted() {
      return fitted;
    },
    sizes() {
      const size = hostSize();
      const box = contentSize();
      return {
        host: size,
        content: box,
        fitScale: clampScale(fitScale(size, box, padding), limits()),
        realZoom: transform.scale,
      };
    },
    zoomBy(factor, at) {
      zoomTo(transform.scale * factor, at);
    },
    zoomTo,
    panBy(delta) {
      commit(panTransformBy(transform, delta));
    },
    fit,
    resize,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", endPointer);
      host.removeEventListener("pointercancel", endPointer);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("dblclick", onDoubleClick);
      host.removeEventListener("contextmenu", onContextMenu);
      if (frame !== 0) cancelAnimationFrame(frame);
      listeners.clear();
      pointers.clear();
    },
  };
}
