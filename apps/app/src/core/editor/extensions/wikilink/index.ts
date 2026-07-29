/**
 * The `[[` lane's public seam (§5.5, P4c).
 *
 * The host supplies the project's documents; this lane supplies the trigger,
 * the predicate, and what a choice writes; the surface in
 * `features/editor/surfaces/link/` renders the open menu. What the rows are and
 * how they rank is [`@/core/completion`](../../../completion/index.ts), which
 * the composer shares. Nothing outside this directory needs the suggestion
 * plugin or the predicate.
 */

export {
  getWikilinkMenu,
  type WikilinkExtensionOptions,
  type WikilinkMenu,
  type WikilinkMenuSnapshot,
  WikilinkSuggestionExtension,
  wikilinkSuggestionPluginKey,
} from "./WikilinkSuggestionExtension";
export { insertWikilink } from "./wikilink-insertion";
export { allowsWikilinkTrigger } from "./wikilink-trigger";
