/**
 * The link surfaces: the destination hint, the context menu, and the form.
 *
 * Hosts mount `LinkSurfaces` through `EDITOR_CHROME_SURFACES` and nothing
 * else. Everything a link surface needs it reads from the link store in
 * `core/editor/links/`.
 */
export { LinkSurfaces } from "./LinkSurfaces";
export { useLinkSurface, useLinkSurfaceState } from "./useLinkSurface";
