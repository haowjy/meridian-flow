/**
 * The `[[` lane: two brackets in prose open the link picker (§5.5).
 *
 * The same mechanism the slash lane uses, because a writer meets both the same
 * way — the query is the prose, the caret stays in it, and Escape leaves the
 * literal `[[` text alone. What differs is only what this offers and what a
 * choice writes: `link-picker-trigger.ts` says where it may open,
 * `link-picker-items.ts` says what matched, and `document-link-insertion.ts`
 * says what lands in the document — a standard Markdown link, never `[[…]]`.
 *
 * `allowSpaces` is on, and has to be: document names have spaces in them, and
 * a menu that stopped filtering at "The Second" would be a menu that cannot
 * find "The Second Gate". The cost is that the match runs to the end of the
 * text node, which is why a query carrying `]` offers nothing.
 */

import type { SuggestionMenu } from "@/core/completion";
import { autoClosedRunLength } from "../auto-pair";
import {
  createSuggestionLane,
  defaultSuggestionLaneDriver,
  type SuggestionLaneOptions,
} from "../suggestion";
import { insertDocumentLink } from "./document-link-insertion";
import { type LinkPickerCatalog, type LinkPickerItem, linkPickerItems } from "./link-picker-items";
import { allowsLinkPickerTrigger } from "./link-picker-trigger";

export type LinkPickerMenu = SuggestionMenu<LinkPickerItem>;

export type LinkPickerExtensionOptions = Pick<SuggestionLaneOptions<LinkPickerCatalog>, "catalog">;

const linkPickerLane = createSuggestionLane<LinkPickerCatalog, LinkPickerItem>({
  name: "linkPickerSuggestion",
  char: "[[",
  allowSpaces: true,
  driver: defaultSuggestionLaneDriver,
  keymapId: "link-picker-menu",
  label: (catalog) => catalog.label,
  allows: allowsLinkPickerTrigger,
  items: linkPickerItems,
  rowId: (entry) => entry.key,
  choose: ({ editor, catalog, range, entry }) => {
    // The trigger's own range stops at the caret, and the `]]` auto-pairing
    // wrote for the second bracket sits just past it. The writer typed one
    // gesture, so the link replaces all of it — a range that stopped at the
    // caret would strand the closers behind the link it just wrote.
    const to = range.to + autoClosedRunLength(editor.state, range.to);
    insertDocumentLink(
      editor,
      { from: range.from, to },
      { label: entry.name, uri: entry.uri, holderUri: catalog.holderUri },
    );
  },
});

export const LinkPickerExtension = linkPickerLane.extension;
export const getLinkPickerMenu = linkPickerLane.getMenu;
