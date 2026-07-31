/**
 * The `[[` lane: two brackets in prose open the document menu (§5.5).
 *
 * The same mechanism the slash lane uses, because a writer meets both the same
 * way — the query is the prose, the caret stays in it, and Escape leaves the
 * literal `[[` text alone. What differs is only what this offers and what a
 * choice writes: `wikilink-trigger.ts` says where it may open,
 * `@/core/completion`'s catalog says what matched, and `wikilink-insertion.ts`
 * says what lands in the document.
 *
 * `allowSpaces` is on, and has to be: document titles have spaces in them, and
 * a menu that stopped filtering at "The Second" would be a menu that cannot
 * find "The Second Gate". The cost is that the match runs to the end of the
 * text node, which is why the catalog refuses a query carrying `]` — a writer
 * who closed the brackets themselves is left alone with their own text.
 */

import {
  filterWikilinkItems,
  type SuggestionMenu,
  type WikilinkCatalog,
  type WikilinkMenuItem,
} from "@/core/completion";
import { autoClosedRunLength } from "../auto-pair";
import { createSuggestionLane, type SuggestionLaneOptions } from "../suggestion";
import { insertWikilink } from "./wikilink-insertion";
import { allowsWikilinkTrigger } from "./wikilink-trigger";

export type WikilinkMenu = SuggestionMenu<WikilinkMenuItem>;

export type WikilinkExtensionOptions = SuggestionLaneOptions<WikilinkCatalog>;

const wikilinkLane = createSuggestionLane<WikilinkCatalog, WikilinkMenuItem>({
  name: "wikilinkSuggestion",
  char: "[[",
  allowSpaces: true,
  keymapId: "wikilink-menu",
  label: (catalog) => catalog.label,
  allows: allowsWikilinkTrigger,
  items: (catalog, query) => filterWikilinkItems(catalog.documents, query),
  choose: ({ editor, range, entry }) => {
    // The trigger's own range stops at the caret, and the `]]` auto-pairing
    // wrote for the second bracket sits just past it. The writer typed one
    // gesture, so the link replaces all of it — a range that stopped at the
    // caret would strand the closers behind the link it just wrote.
    const to = range.to + autoClosedRunLength(editor.state, range.to);
    insertWikilink(editor, { from: range.from, to }, entry.name);
  },
});

export const WikilinkSuggestionExtension = wikilinkLane.extension;
export const getWikilinkMenu = wikilinkLane.getMenu;
