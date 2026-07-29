/**
 * The link system's public seam.
 *
 * Everything here is headless: classification, commands, the click decision,
 * and the per-editor store. React lives in `features/editor/surfaces/link/`,
 * which is where a link surface actually renders.
 */

export {
  followLinkAtSelection,
  getLinkSurface,
  LinkSurfaceExtension,
  openLinkForm,
} from "./LinkSurfaceExtension";
export {
  commitLinkDraft,
  type LinkCommit,
  type LinkCommitResult,
  type LinkDraft,
  type LinkSelection,
  linkAt,
  linkAtSelection,
  linkAttributesAtSelection,
  linkHref,
  mapLinkDraft,
  removeLinkAt,
  resolveLinkDraft,
} from "./link-commands";
export {
  canFollowLink,
  followLink,
  type InternalLinkNavigator,
  LINK_CLICK_SLOP_PX,
  type LinkClickAction,
  type LinkClickGesture,
  type LinkFollowResult,
  linkClickAction,
} from "./link-navigation";
export {
  createLinkSurface,
  type LinkFormRequest,
  type LinkHint,
  type LinkMenuRequest,
  type LinkPoint,
  type LinkRange,
  type LinkSurface,
  type LinkSurfaceState,
} from "./link-surface";
export {
  classifyLinkTarget,
  documentLinkTarget,
  isInternalLinkTarget,
  type LinkTarget,
  type LinkTargetKind,
  linkDestinationLabel,
  normalizeLinkHref,
} from "./link-target";
