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
    return [
      new Plugin({
        key: wikilinkPastePluginKey,
        props: {
          transformPasted: (slice, view) => {
            // A drag inside the editor moves text it already holds, which
            // stays as written.
            if (view.dragging) return slice;
            const catalog = read();
            return catalog ? linkPastedWikilinks(slice, view.state.schema, catalog) : slice;
          },
        },
      }),
    ];
  },
});
