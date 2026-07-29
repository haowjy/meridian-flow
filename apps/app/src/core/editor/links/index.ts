/**
 * The link system's public seam.
 *
 * Everything here is headless: classification, commands, the click decision,
 * and the per-editor store. React lives in `features/editor/surfaces/link/`,
 * which is where a link surface actually renders.
 */

export {
  followLinkAtSelection,
  getLinkResolution,
  getLinkSurface,
  LinkSurfaceExtension,
  openLinkForm,
} from "./LinkSurfaceExtension";
export {
  anchorLinkRange,
  commitLinkDraft,
  type LinkAnchor,
  type LinkCommit,
  type LinkCommitResult,
  type LinkDraft,
  type LinkSelection,
  linkAt,
  linkAtSelection,
  linkAttributesAtSelection,
  linkHref,
  mapLinkDraft,
  relocateLink,
  removeLinkAt,
  resolveLinkAnchor,
  resolveLinkDraft,
  selectionCoversLink,
} from "./link-commands";
export {
  canFollowLink,
  followLink,
  type InternalLinkNavigator,
  LINK_CLICK_SLOP_PX,
  type LinkClickGesture,
  type LinkClickIntent,
  type LinkFollowDisposition,
  type LinkFollowRequest,
  type LinkFollowResult,
  linkClickIntent,
  MIDDLE_BUTTON,
} from "./link-navigation";
export {
  createLinkResolution,
  type InternalLinkResolver,
  type LinkResolution,
  type LinkResolutionEntry,
  type LinkResolutionState,
} from "./link-resolution";
export {
  createLinkSurface,
  type LinkFormRequest,
  type LinkHint,
  type LinkMenuRequest,
  type LinkMenuTarget,
  type LinkPoint,
  type LinkRange,
  type LinkSurface,
  type LinkSurfaceState,
  linkMenuRange,
} from "./link-surface";
export {
  classifyLinkTarget,
  documentLinkTarget,
  isInternalLinkTarget,
  type LinkTarget,
  type LinkTargetKind,
  linkTargetHref,
  normalizeLinkHref,
} from "./link-target";
