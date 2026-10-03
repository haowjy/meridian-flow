/**
 * The paste policy for `[[Name]]` (D15): which pastes convert, and the
 * catalog they convert against. The conversion itself is `wikilink-paste.ts`.
 *
 * It hooks `transformPasted`, the one prop every paste kind (Markdown through
 * the paste door, plain prose, HTML) reaches once, after parsing, so it sees
 * nodes and can leave code alone. Only the Editor mounts it, with a catalog
 * read at paste time; while that catalog is null (the link index still
 * loading) nothing links, rather than every link turning dashed, though
 * escapes are still spelled out.
 */

import { type Editor, Extension } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import type { PluggableList } from "unified";

import { remarkKeepWikilinkEscapes } from "./wikilink-escape";
import { linkPastedWikilinks, type WikilinkPasteCatalog } from "./wikilink-paste";

export type WikilinkPasteOptions = {
  /** Read at paste time; null converts nothing. */
  catalog: () => WikilinkPasteCatalog | null;
};

const WIKILINK_PASTE_NAME = "wikilinkPaste";
const wikilinkPastePluginKey = new PluginKey(WIKILINK_PASTE_NAME);

type WikilinkPasteStorage = { markdownPastePlugins: PluggableList };

declare module "@tiptap/core" {
  interface Storage {
    wikilinkPaste: WikilinkPasteStorage;
  }
}

/**
 * The parse extensions this extension contributes to the Markdown paste door:
 * the one that keeps an escaped `\[[` visible to the transform below. Empty
 * where it is not mounted, so the door can never keep a backslash that
 * nothing spells out again.
 */
export function wikilinkPasteParsePlugins(editor: Editor): PluggableList {
  return editor.storage[WIKILINK_PASTE_NAME]?.markdownPastePlugins ?? [];
}

export const WikilinkPasteExtension = Extension.create<WikilinkPasteOptions, WikilinkPasteStorage>({
  name: WIKILINK_PASTE_NAME,

  addOptions() {
    return { catalog: () => null };
  },

  addStorage() {
    return { markdownPastePlugins: [remarkKeepWikilinkEscapes] };
  },

  addProseMirrorPlugins() {
    const read = this.options.catalog;
    // ProseMirror's paste-without-formatting flag, ORed with "the destination
    // is code", from `transformPastedText`. That hook and `transformPasted`
    // run as a synchronous pair inside one parse of clipboard text, so the
    // flag never outlives the paste that set it.
    let plainOrCode = false;
    // Where a drop from outside lands, which the transform cannot see. Cleared
    // after the event: ProseMirror handles a drop synchronously, and a drop it
    // abandons must not leave a destination for a later paste.
    let pendingDrop: ResolvedPos | null = null;
    return [
      new Plugin({
        key: wikilinkPastePluginKey,
        props: {
          handleDOMEvents: {
            drop: (view, event) => {
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              pendingDrop = at ? view.state.doc.resolve(at.pos) : null;
              queueMicrotask(() => {
                pendingDrop = null;
              });
              return false;
            },
          },
          // Paste without formatting (Ctrl/Cmd+Shift+V) is the flag the
          // Markdown door reads as `plain`: the writer asked for the
          // characters, and it is how they paste literal brackets.
          transformPastedText: (text, plain) => {
            plainOrCode = plain;
            return text;
          },
          transformPasted: (slice, view) => {
            const keep = plainOrCode;
            plainOrCode = false;
            // The destination as every paste path resolves it (a keyed paste,
            // the menu's pasteHTML and pasteText): the drop's pointer, or the
            // selection. Code is literal characters; a link mark cannot live
            // there, so converting would keep only the label. A drag inside
            // the editor moves text it already holds, as written.
            const destination = pendingDrop ?? view.state.selection.$from;
            if (keep || view.dragging || isCode(destination)) return slice;
            // A catalog still loading links nothing, but the escapes the door
            // kept are spelled out all the same.
            return linkPastedWikilinks(slice, view.state.schema, read());
          },
        },
      }),
    ];
  },
});

function isCode($pos: ResolvedPos): boolean {
  return Boolean($pos.parent.type.spec.code);
}
