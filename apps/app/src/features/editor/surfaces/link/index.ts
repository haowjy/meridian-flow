/**
 * The link surfaces: the destination hint, the context menu, the form, the `[[`
 * menu, and what a follow says when it finds nothing.
 *
 * Every surface here mounts through `EDITOR_CHROME_SURFACES` and reads the stores
 * in `core/editor/links/` (or the `[[` trigger's own menu store). The one
 * component a host mounts directly is `ProjectLinkRuntime`, which renders
 * nothing: it is the app's ports, not a surface.
 */
export { FollowOutcomeDialog } from "./FollowOutcomeDialog";
export { LinkSurfaces } from "./LinkSurfaces";
export { ProjectLinkRuntime } from "./ProjectLinkRuntime";
export { type LinkableDocumentIndex, useLinkableDocuments } from "./useLinkableDocuments";
export { useLinkResolution } from "./useLinkResolution";
export { useLinkSurface, useLinkSurfaceState } from "./useLinkSurface";
export { WikilinkMenu } from "./WikilinkMenu";
