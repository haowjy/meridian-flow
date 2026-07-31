/**
 * The `[[` lane's public seam (§5.5, P4c).
 *
 * The host supplies the project's documents; this lane supplies the trigger and
 * what a choice writes; the surface in `features/editor/surfaces/link/` renders
 * the open menu. What the rows are and how they rank is
 * [`@/core/references`](../../../references/index.ts), which the composer
 * shares. Where the trigger may open is the shared envelope in
 * [`../suggestion/`](../suggestion/trigger-envelope.ts).
 *
 * `insertWikilink` leaves this directory because `@` writes a document
 * reference too, and one spelling is the point (a second implementation is two
 * triggers that disagree about what a title means). Nothing else here is
 * anyone's business: not the suggestion plugin, not the menu store.
 */

export {
  getWikilinkMenu,
  type WikilinkExtensionOptions,
  type WikilinkItem,
  type WikilinkMenu,
  WikilinkSuggestionExtension,
} from "./WikilinkSuggestionExtension";
export { insertWikilink } from "./wikilink-insertion";
