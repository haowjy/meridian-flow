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

import { Extension } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { linkPastedWikilinks, type WikilinkPasteCatalog } from "./wikilink-paste";

export type WikilinkPasteOptions = {
  /** Read at paste time; null converts nothing. */
  catalog: () => WikilinkPasteCatalog | null;
};

const wikilinkPastePluginKey = new PluginKey("wikilinkPaste");

export const WikilinkPasteExtension = Extension.create<WikilinkPasteOptions>({
  name: "wikilinkPaste",

  addOptions() {
    return { catalog: () => null };
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
          transformPasted: (slice, view) => {
            const keep = keepCharacters;
            keepCharacters = false;
            // A drag inside the editor moves text it already holds, which
            // stays as written.
            if (keep || view.dragging) return slice;
            const catalog = read();
            return catalog ? linkPastedWikilinks(slice, view.state.schema, catalog) : slice;
          },
        },
      }),
    ];
  },
});

function isCode($pos: ResolvedPos): boolean {
  return Boolean($pos.parent.type.spec.code);
}
