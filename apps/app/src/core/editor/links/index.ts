/**
 * The link system's public seam.
 *
 * Everything here is headless: classification, commands, the click decision,
 * and the per-editor store. React lives in `features/editor/surfaces/link/`,
 * which is where a link surface actually renders.
 */

export { LinkSurfaceExtension, openLinkForm } from "./LinkSurfaceExtension";
export {
  addressDocumentName,
  type CreatableLinkScheme,
  documentFileName,
  isCreatableLinkScheme,
  isLinkDocumentScheme,
  linkAheadAddress,
  linkTargetAddress,
} from "./link-address";
export {
  type AssignedLink,
  assignPastedNodes,
  assignWrittenHref,
  indexedDocumentAt,
  indexedDocumentAtExactly,
  type LinkAssignmentDocument,
  type LinkAssignmentIndex,
  type LinkAssignmentScope,
} from "./link-assignment";
export {
  LINK_CHIP_ICONS,
  type LinkChipIcon,
  linkChip,
  linkChipAttributes,
  referenceChip,
} from "./link-chip";
export {
  clipboardLinkAddress,
  clipboardLinkProject,
  clipboardLinkRef,
  clipboardLinkScope,
  LINK_ADDRESS_ATTRIBUTE,
  LINK_PROJECT_ATTRIBUTE,
  LINK_REF_ATTRIBUTE,
} from "./link-clipboard";
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
  createLinkAnswerCache,
  type DocumentAnswer,
  type InternalLinkResolver,
  type LinkAnswer,
  type LinkAnswerCache,
  type LinkKey,
  type LinkQuestion,
  type LinkResolutionEntry,
  type LocalLinkAnswer,
  linkCacheKey,
  linkKeyOfMark,
} from "./link-resolution";
export { getLinkAnswerCache, getLinkSurface } from "./link-storage";
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
  internalClipboardTarget,
  isInternalLinkTarget,
  type LinkTarget,
  linkInputStepsAsideFromReferences,
  linkTargetHref,
  linkTargetLabel,
  normalizeLinkHref,
} from "./link-target";
export {
  WikilinkPasteExtension,
  type WikilinkPasteOptions,
  wikilinkPasteParsePlugins,
} from "./WikilinkPasteExtension";
export type { WikilinkPasteCatalog } from "./wikilink-paste";
