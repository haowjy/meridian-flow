/**
 * The `[[` lane's public seam (§5.5, P4c).
 *
 * The host supplies the project's documents; the editor supplies the trigger;
 * the surface in `features/editor/surfaces/link/` renders the open menu.
 * Nothing outside this directory needs the suggestion plugin, the ranking, or
 * the predicate.
 */

export {
  getWikilinkMenu,
  type WikilinkMenu,
  type WikilinkMenuSnapshot,
  WikilinkSuggestionExtension,
  wikilinkSuggestionPluginKey,
} from "./WikilinkSuggestionExtension";
export {
  filterWikilinkItems,
  type WikilinkCatalog,
  type WikilinkDocument,
  type WikilinkExtensionOptions,
  type WikilinkMenuItem,
} from "./wikilink-catalog";
export { insertWikilink } from "./wikilink-insertion";
export { allowsWikilinkTrigger, WIKILINK_TRIGGER_BLOCKS } from "./wikilink-trigger";
