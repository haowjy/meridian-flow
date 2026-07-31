/**
 * The `[[` lane: two brackets in prose open the document menu (§5.5).
 *
 * The same mechanism the slash lane uses, because a writer meets both the same
 * way — the query is the prose, the caret stays in it, and Escape leaves the
 * literal `[[` text alone. What differs is only what this offers and what a
 * choice writes: `wikilink-trigger.ts` says where it may open,
 * `@/core/references` ranks what matched, and `wikilink-insertion.ts` says what
 * lands in the document.
 *
 * Documents and nothing else. The catalog the host hands over is every
 * reference in scope, images included, and `[[` narrows it to what a title can
 * name — an image has no title the resolver could match.
 *
 * `allowSpaces` is on, and has to be: document titles have spaces in them, and
 * a menu that stopped filtering at "The Second" would be a menu that cannot
 * find "The Second Gate". The cost is that the match runs to the end of the
 * text node, which is why a query carrying `]` gets no rows — a writer who
 * closed the brackets themselves is left alone with their own text.
 */

import type { SuggestionMenu } from "@/core/completion";
import {
  filterReferenceItems,
  type ReferenceCatalog,
  type ReferenceItemOf,
} from "@/core/references";
import { autoClosedRunLength } from "../auto-pair";
import { createSuggestionLane, type SuggestionLaneOptions } from "../suggestion";
import { insertWikilink } from "./wikilink-insertion";
import { allowsWikilinkTrigger } from "./wikilink-trigger";

/** `[[` names documents, so an asset row can never reach this menu. */
export type WikilinkItem = ReferenceItemOf<"document">;

export type WikilinkMenu = SuggestionMenu<WikilinkItem>;

export type WikilinkExtensionOptions = SuggestionLaneOptions<ReferenceCatalog>;

const WIKILINK_SCOPE = ["document"] as const;

/**
 * What `[[…]]` cannot carry between its brackets. `]` or `|` means the writer
 * already closed or piped their own construct, and a newline means the trigger
 * ran off the end of the sentence it opened in — none of the three is a name
 * the wire format could spell back.
 */
const UNSPELLABLE_QUERY = /[\r\n[\]|]/;

const wikilinkLane = createSuggestionLane<ReferenceCatalog, WikilinkItem>({
  name: "wikilinkSuggestion",
  char: "[[",
  allowSpaces: true,
  keymapId: "wikilink-menu",
  label: (catalog) => catalog.label,
  allows: allowsWikilinkTrigger,
  items: (catalog, query) =>
    UNSPELLABLE_QUERY.test(query)
      ? []
      : filterReferenceItems(catalog.candidates, WIKILINK_SCOPE, query),
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
