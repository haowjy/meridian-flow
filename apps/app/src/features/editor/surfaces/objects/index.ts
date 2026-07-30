/**
 * L-B: object controls and the lightbox — the public face of this lane.
 *
 * `ObjectControls` is the whole surface: one entry in
 * `EDITOR_CHROME_SURFACES`, no props but the editor. Everything else is
 * exported for tests and for a later lane that needs the same readings.
 */

export { CodeBlockChips } from "./CodeBlockChips";
export {
  type FenceRebase,
  fenceRebaseAfter,
  fenceSourceTransaction,
  minimalTextPatch,
  type TextPatch,
  useFenceDraft,
} from "./fence-draft";
export { ObjectControls } from "./ObjectControls";
export { ObjectFieldPopover, type ObjectFieldPopoverProps } from "./ObjectFieldPopover";
export { ObjectLightbox, type ObjectLightboxProps } from "./ObjectLightbox";
export {
  isDiagramFence,
  type ObjectSurfaceTarget,
  objectPosForElement,
  objectSurfaceAt,
  objectSurfaceAtPos,
  objectSurfaceForHold,
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
  renderedDiagramSvg,
  setFenceLanguage,
  setObjectField,
  sizedSvgMarkup,
  svgToPngBlob,
} from "./object-commands";
export {
  ObjectMenuItems,
  type ObjectVerbContext,
  objectFieldLabel,
  objectRowItems,
} from "./object-menu-items";
export { useApproachedObject } from "./useApproachedObject";
export { ViewerCanvas } from "./ViewerCanvas";
export {
  ObjectVerbNotice,
  type RunVerb,
  useVerbFeedback,
  verbFailureMessage,
} from "./verb-feedback";
