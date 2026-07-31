/**
 * The peer-mark surface: one entry in `EDITOR_CHROME_SURFACES`.
 *
 * Which mark is open lives in the editor (`core/editor/extensions/`), so the
 * host hands this surface the editor and nothing else, like every other lane.
 */
export { PeerMarkPopover, type PeerMarkPopoverTarget } from "./PeerMarkPopover";
export { PeerMarkSurface } from "./PeerMarkSurface";
