export {
  ChromeKernelExtension,
  editorChromeAttributes,
  getEditorChrome,
  isEditorChromeElement,
} from "./ChromeKernelExtension";
export {
  CHROME_CONTEXT_KINDS,
  type ChromeContext,
  type ChromeContextKind,
  chromeContextAt,
  DOCUMENT_CHROME_CONTEXT,
  proseSelectionCovers,
  resolveChromeContext,
} from "./chrome-context";
export {
  CONTEXT_CLAIM_ORDER,
  type ContextClaimHandler,
  type ContextClaimId,
  type ContextClaimTarget,
  resolveContextClaim,
} from "./context-claims";
export type {
  ChromeLayerDismissal,
  ChromeLayerHandle,
  ChromeLayerOptions,
  ChromeLayerRetreat,
  EditorChrome,
} from "./editor-chrome";
export {
  type ChromeLayer,
  type EscSituation,
  type EscStep,
  escStep,
  type GesturePhase,
} from "./esc-chain";
export {
  createHoverAnchors,
  type HoverAnchorLane,
  type HoverAnchors,
  type HoverProbe,
  type HoverProbeResolver,
  hoverOwner,
} from "./hover-anchor";
// `createHoverIntent` itself is deliberately NOT here. Approach chrome joins
// the kernel's one approach (`registerHoverAnchor`); a lane with its own intent
// has its own pointer, and four private pointers is the defect this replaced.
export { CHROME_TIMING, type HoverIntentTimers } from "./hover-intent";
export {
  KEYMAP_SCOPE_ORDER,
  type KeymapBinding,
  type KeymapContribution,
  type KeymapScope,
} from "./keymap";
export { watchManuscriptLayout } from "./manuscript-layout";
export { type PressStart, pastSlop, trackPress } from "./track-press";
