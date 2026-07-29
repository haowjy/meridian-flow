/**
 * The chrome kernel's public seam.
 *
 * Six surface lanes build on exactly what this file exports. Everything here
 * is headless: policy, timing, and registration. React lives in
 * `features/editor/chrome/`, which is where a surface actually renders.
 */

export { ChromeKernelExtension, getEditorChrome } from "./ChromeKernelExtension";
export {
  CHROME_CONTEXT_KINDS,
  type ChromeContext,
  type ChromeContextKind,
  chromeContextAt,
  DOCUMENT_CHROME_CONTEXT,
  resolveChromeContext,
} from "./chrome-context";
export {
  CONTEXT_CLAIM_ORDER,
  type ContextClaimHandler,
  type ContextClaimId,
  type ContextClaimTarget,
  resolveContextClaim,
} from "./context-claims";
export {
  type ChromeLayerHandle,
  type ChromeLayerOptions,
  createEditorChrome,
  type EditorChrome,
  type EditorChromeController,
} from "./editor-chrome";
export {
  advanceEscSituation,
  type ChromeLayer,
  type EscSituation,
  type EscStep,
  escStep,
  escWalkHome,
  type GesturePhase,
} from "./esc-chain";
export {
  CHROME_TIMING,
  createHoverIntent,
  type HoverIntent,
  type HoverIntentOptions,
} from "./hover-intent";
export {
  KEYMAP_SCOPE_ORDER,
  type KeymapBinding,
  type KeymapContribution,
  type KeymapScope,
  mergeKeymapContributions,
} from "./keymap";
