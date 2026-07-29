/**
 * What the two typed-under menus share (`/` in §5.7, `[[` in §5.5).
 *
 * The store only. Where a trigger may open, what it offers, and what a choice
 * does to the document are each lane's own answer, and nothing here reads the
 * editor.
 */

export {
  closedSuggestionMenu,
  createSuggestionMenu,
  type SuggestionMenu,
  type SuggestionMenuController,
  type SuggestionMenuSession,
  type SuggestionMenuSnapshot,
} from "./suggestion-menu-store";
