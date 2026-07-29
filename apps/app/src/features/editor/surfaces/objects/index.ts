/**
 * L-B: object controls and the lightbox — the public face of this lane.
 *
 * `ObjectControls` is the whole surface: one entry in
 * `EDITOR_CHROME_SURFACES`, no props but the editor. Everything else is
 * exported for tests and for a later lane that needs the same readings.
 */

export { CodeBlockChips } from "./CodeBlockChips";
export { ObjectControls } from "./ObjectControls";
export { ObjectLightbox, type ObjectLightboxProps } from "./ObjectLightbox";
export {
  isMermaidFence,
  type ObjectSurfaceKind,
  type ObjectSurfaceTarget,
  objectPosForElement,
  objectSurfaceAt,
  objectSurfaceAtPos,
  objectSurfaceKind,
} from "./object-anchors";
export {
  copyImageFrom,
  copySvgImage,
  copyText,
  deleteObject,
  downloadImageFrom,
  downloadPng,
  duplicateObject,
  fenceSource,
  minimalTextPatch,
  renderedDiagramSvg,
  setFenceLanguage,
  setFenceSource,
  sizedSvgMarkup,
  svgToPngBlob,
  type TextPatch,
} from "./object-commands";
export { useApproachedObject } from "./useApproachedObject";
export { ViewerCanvas } from "./ViewerCanvas";
