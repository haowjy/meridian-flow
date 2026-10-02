/**
 * The paste policy for `[[Name]]` (D15): which pastes convert, and the
 * catalog they convert against. The conversion itself is `wikilink-paste.ts`.
 *
 * It hooks `transformPasted`, the one prop every paste kind (Markdown through
 * the paste door, plain prose, HTML) reaches once, after parsing, so it sees
 * nodes and can leave code alone. Only the Editor mounts it, with a catalog
 * read at paste time; while that catalog is null (the link index still
 * loading) nothing converts, rather than every link turning dashed.
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
    // Whether the paste or drop in flight keeps its characters. Set where the
    // gesture starts, before ProseMirror parses it; read and cleared by the
    // transform, which has no destination of its own to look at.
    let keepCharacters = false;
    return [
      new Plugin({
        key: wikilinkPastePluginKey,
        props: {
          handleDOMEvents: {
            // Code is literal characters: a link mark cannot live there, so
            // converting would drop the brackets and keep only the label.
            paste: (view) => {
              keepCharacters = isCode(view.state.selection.$from);
              return false;
            },
            // A drop lands where ProseMirror resolves the pointer (`$mouse`).
            drop: (view, event) => {
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              keepCharacters = at ? isCode(view.state.doc.resolve(at.pos)) : false;
              return false;
            },
          },
          // ProseMirror's own paste-without-formatting flag (Ctrl/Cmd+Shift+V),
          // the one the Markdown door reads as `plain`, arrives here ORed with
          // "the destination is code"; either way the writer gets the
          // characters, which is also how they paste literal brackets.
          transformPastedText: (text, plainOrCode) => {
            if (plainOrCode) keepCharacters = true;
            return text;
          },
          transformPasted: (slice, view) => {
            const keep = keepCharacters;
            keepCharacters = false;
            // A drag inside the editor moves text it already holds, which
            // stays as written.
            if (keep || view.dragging) return slice;
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
