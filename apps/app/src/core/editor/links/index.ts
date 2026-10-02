/**
 * The link system's public seam.
 *
 * Everything here is headless: classification, commands, the click decision,
 * and the per-editor store. React lives in `features/editor/surfaces/link/`,
 * which is where a link surface actually renders.
 */

export {
  getLinkResolution,
  getLinkSurface,
  LinkSurfaceExtension,
  openLinkForm,
} from "./LinkSurfaceExtension";
export {
  type CreatableLinkScheme,
  documentFileName,
  isCreatableLinkScheme,
  linkAheadAddress,
  linkTargetAddress,
} from "./link-address";
export {
  LINK_CHIP_ICONS,
  type LinkChipIcon,
  linkChip,
  linkChipAttributes,
  referenceChip,
} from "./link-chip";
export { clipboardLinkAddress, LINK_ADDRESS_ATTRIBUTE, linksAsAddresses } from "./link-clipboard";
export {
  commitLinkDraft,
  type LinkAnchor,
  type LinkDraft,
  linkAttributesAtSelection,
  mapLinkDraft,
  removeLinkAt,
  resolveLinkDraft,
  selectionCoversLink,
} from "./link-commands";
export {
  canFollowLink,
  followLink,
  type InternalLinkNavigator,
  type LinkFollowDisposition,
} from "./link-navigation";
export { createLinkRequester, type LinkRequester } from "./link-requester";
export {
  createLinkResolution,
  type InternalLinkResolver,
  type LinkResolution,
  type LinkResolutionEntry,
} from "./link-resolution";
export {
  type LinkFollowOutcome,
  type LinkFormRequest,
  type LinkHint,
  type LinkMenuRequest,
  type LinkSurface,
  type LinkSurfaceState,
  linkMenuRange,
} from "./link-surface";
export {
  classifyLinkTarget,
  documentLinkTarget,
  internalClipboardTarget,
  isInternalLinkTarget,
  type LinkTarget,
  linkInputStepsAsideFromReferences,
  linkTargetHref,
  linkTargetLabel,
  normalizeLinkHref,
} from "./link-target";
export { WikilinkPasteExtension, type WikilinkPasteOptions } from "./WikilinkPasteExtension";
export type { WikilinkPasteCatalog } from "./wikilink-paste";
