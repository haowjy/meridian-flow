/**
 * The editor's link lane: everything about a link that touches a document.
 *
 * The mark commands, the click decision, the per-editor surface store, and the
 * extension that mounts them. What an href MEANS and what it points at are
 * [`@/core/links`](../../links/index.ts) — a string question the chat
 * transcript asks too — and a consumer that needs the classifier imports it
 * from there rather than through this lane.
 *
 * Everything here is headless. React lives in `features/editor/surfaces/link/`,
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
  createLinkSurface,
  type LinkFollowOutcome,
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
