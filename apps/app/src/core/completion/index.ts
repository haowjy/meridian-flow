/**
 * Completion: the headless half of every menu a writer types underneath.
 *
 * One thing lives here, and it does not know what is rendering it: the
 * open-menu store that `/`, `[[`, `@`, and whatever trigger comes next all
 * publish through. Nothing in this module imports ProseMirror, the DOM, or
 * React. The one piece of geometry a menu carries is `anchorRect`, and that is
 * a callback its host supplies.
 *
 * **Why this sits beside `core/editor` rather than inside it.** Read the real
 * dependency graph: this file imports nothing at all, and its consumers are the
 * editor's TipTap lanes (`core/editor/extensions/{slash,wikilink}`), the
 * editor's React surfaces (`features/editor/surfaces/{slash,link}`), and —
 * next — the chat composer, which is a plain `<textarea>` in `features/chat/`.
 * Imports run `core/*` → `features/*`, and one feature never reaches into
 * another's internals, so `core/` is the shallowest node covering every
 * consumer. Left under `core/editor`, the composer would have to import the
 * editor to open a menu under a textarea, which is a layering smell standing in
 * for a shared module. That is the same reason `core/session` and
 * `core/transport` are siblings rather than tenants of whoever needed them
 * first.
 *
 * **Why the rows are not here.** What a reference may name is
 * [`../references`](../references/index.ts). The slash menu references
 * nothing — it offers blocks — so a module holding both would make the menu
 * store learn about documents, assets, and eventually people to no purpose. The
 * two change for different reasons: a menu learns new physics, a catalog learns
 * new kinds of thing.
 *
 * **Why not a package.** Nothing outside `apps/app` completes anything: the
 * server resolves links, it does not rank them. A package would buy a build
 * target and an export boundary for zero cross-app consumers.
 */

export {
  closedSuggestionMenu,
  createSuggestionMenu,
  type SuggestionMenu,
  type SuggestionMenuController,
  type SuggestionMenuSession,
  type SuggestionMenuSnapshot,
} from "./suggestion-menu-store";
