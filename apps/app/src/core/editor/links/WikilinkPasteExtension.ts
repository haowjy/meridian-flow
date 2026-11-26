import { type Editor, Extension } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import type { PluggableList } from "unified";

import { landingAt } from "../landing/point-landing";
import { viewGeometry } from "../landing/view-geometry";
import { remarkKeepWikilinkEscapes } from "./wikilink-escape";
import { linkPastedWikilinks, type WikilinkPasteCatalog } from "./wikilink-paste";

export type WikilinkPasteOptions = {
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
    const editor = this.editor;
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
              const landing = landingAt(
                view.state,
                { x: event.clientX, y: event.clientY },
                viewGeometry(view, editor),
              );
              pendingDrop = view.state.doc.resolve(landing.pos);
              queueMicrotask(() => {
                pendingDrop = null;
              });
              return false;
            },
          },
          transformPastedText: (text, plain) => {
            plainOrCode = plain;
            return text;
          },
          transformPasted: (slice, view) => {
            const keep = plainOrCode;
            plainOrCode = false;
            const destination = pendingDrop ?? view.state.selection.$from;
            if (keep || view.dragging || isCode(destination)) return slice;
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
