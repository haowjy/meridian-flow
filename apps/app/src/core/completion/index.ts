/**
 * Completion: the headless half of every menu a writer types underneath.
 *
 * Two things live here, and neither knows what is rendering it: the open-menu
 * store (`/`, `[[`, and whatever trigger comes next all publish through it) and
 * the catalog that ranks the documents a `[[…]]` may name. Nothing in this
 * module imports ProseMirror, the DOM, or React. The one piece of geometry a
 * menu carries is `anchorRect`, and that is a callback its host supplies.
 *
 * **Why this sits beside `core/editor` rather than inside it.** Read the real
 * dependency graph: both files here import nothing at all, and their consumers
 * are the editor's TipTap lanes (`core/editor/extensions/{slash,wikilink}`),
 * the editor's React surfaces (`features/editor/surfaces/{slash,link}`), and —
 * next — the chat composer, which is a plain `<textarea>` in
 * `features/chat/`. Imports run `core/*` → `features/*`, and one feature never
 * reaches into another's internals, so `core/` is the shallowest node covering
 * every consumer. Left under `core/editor`, the composer would have to import
 * the editor to rank a document title in a textarea, which is a layering smell
 * standing in for a shared module. That is the same reason `core/session` and
 * `core/transport` are siblings rather than tenants of whoever needed them
 * first.
 *
 * **Why not a package.** Nothing outside `apps/app` completes anything: the
 * server resolves links, it does not rank them. A package would buy a build
 * target and an export boundary for zero cross-app consumers.
 *
 * **Why "completion" and not "references".** The store serves the slash menu,
 * which references nothing — it offers blocks. Reference candidates are one
 * kind of completion, so the reference catalog fits under this name and the
 * store does not fit under that one.
 */

export {
  closedSuggestionMenu,
  createSuggestionMenu,
  type SuggestionMenu,
  type SuggestionMenuController,
  type SuggestionMenuSession,
  type SuggestionMenuSnapshot,
} from "./suggestion-menu-store";
export {
  filterWikilinkItems,
  type WikilinkCatalog,
  type WikilinkDocument,
  type WikilinkMenuItem,
} from "./wikilink-catalog";
