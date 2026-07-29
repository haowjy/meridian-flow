/**
 * The chrome kernel's public seam.
 *
 * Six surface lanes build on exactly what this file exports. Everything here
 * is headless: policy, timing, and registration. React lives in
 * `features/editor/chrome/`, which is where a surface actually renders.
 */

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
  EditorChrome,
} from "./editor-chrome";
// `escStep` is the policy a surface reasons against; the walk-home proof and
// the store's constructor are the extension's and the tests' business.
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
export {
  CHROME_TIMING,
  createHoverIntent,
  type HoverIntent,
  type HoverIntentOptions,
  type HoverIntentTimers,
} from "./hover-intent";
// The validator and the merge are `registerKeymap`'s and the extension's; a
// lane declares its bindings and the registry does the rest.
export {
  KEYMAP_SCOPE_ORDER,
  type KeymapBinding,
  type KeymapContribution,
  type KeymapScope,
} from "./keymap";
export { watchManuscriptLayout } from "./manuscript-layout";
