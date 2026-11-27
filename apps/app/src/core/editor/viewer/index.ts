/**
 * viewer-core — the pan/zoom seam.
 *
 * Library-grade and editor-free: nothing here imports TipTap, ProseMirror, or
 * React. It moves an element inside another element on PointerEvents, and that
 * is the whole contract. The diagram lightbox is its first caller; an image
 * viewer would be its second without a change.
 */

export { intrinsicContentSize } from "./content-size";
export {
  createPanZoomViewer,
  type PanZoomViewer,
  type PanZoomViewerOptions,
  type ViewerSizes,
} from "./pan-zoom-viewer";
export {
  centerPan,
  clampScale,
  contentPointAt,
  fitScale,
  fitTransform,
  type PointerSpan,
  panTransformBy,
  pinchStep,
  pointerSpan,
  type ViewerPoint,
  type ViewerScaleLimits,
  type ViewerSize,
  type ViewerTransform,
  wheelScaleFactor,
  zoomAtPoint,
} from "./viewer-math";
