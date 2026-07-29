/**
 * What the two typed-under menus share (`/` in §5.7, `[[` in §5.5).
 *
 * The store, and the one piece of the trigger envelope both lanes agree on:
 * which blocks count as prose. The rest of where a trigger may open, what it
 * offers, and what a choice does to the document are each lane's own answer,
 * and nothing here reads the editor.
 */

export { PROSE_TRIGGER_BLOCKS } from "./prose-trigger-blocks";

export {
  closedSuggestionMenu,
  createSuggestionMenu,
  type SuggestionMenu,
  type SuggestionMenuController,
  type SuggestionMenuSession,
  type SuggestionMenuSnapshot,
} from "./suggestion-menu-store";
