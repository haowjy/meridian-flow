/**
 * Keeps Enter from deleting a swept rectangle of table cells.
 *
 * Carets and text ranges decline here, so ProseMirror's base Enter chain splits
 * cell paragraphs exactly as it splits prose elsewhere. A non-text selection
 * that reaches table scope is consumed unchanged: the base chain would delete a
 * `CellSelection`, and Enter must never empty every cell in a sweep.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";

import { getEditorChrome } from "../chrome/ChromeKernelExtension";
import type { KeymapBinding } from "../chrome/keymap";

const TABLE_ENTER_KEYMAP_NAME = "meridianTableEnterKeymap";

function guardCellSweep(): KeymapBinding {
  return ({ selection }) => !(selection instanceof TextSelection);
}

export const TableEnterKeymapExtension = Extension.create({
  name: TABLE_ENTER_KEYMAP_NAME,

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey(TABLE_ENTER_KEYMAP_NAME),
        // Registration rides the plugin's view lifetime, like Tab's: TipTap's
        // `create` event is a macrotask late, which is long enough for a first
        // Enter to miss it.
        view: () => {
          const release = getEditorChrome(editor)?.registerKeymap({
            id: "enter-cell",
            scope: "table",
            // The scope says a table is somewhere above; this says the caret is
            // in a cell's prose rather than on an object or a fence inside it,
            // which keep Enter's own meanings.
            appliesTo: (context) => context.owner === "table-cell",
            bindings: { Enter: guardCellSweep() },
          });
          return { destroy: () => release?.() };
        },
      }),
    ];
  },
});
