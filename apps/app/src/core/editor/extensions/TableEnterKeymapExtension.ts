/**
 * Enter in a table cell breaks the line, the way Docs and Word do.
 *
 * A Meridian cell holds exactly one paragraph (`MeridianTableCell`), so every
 * rung of ProseMirror's base Enter chain declines in one: there is nothing to
 * lift, nothing to create a paragraph near, and `canSplit` refuses a second
 * paragraph the cell's content expression would not hold. Nobody else claimed
 * the key at table scope, so the press reached the browser unhandled and a
 * writer pressing Enter in a cell watched nothing happen at all.
 *
 * The line break is the answer rather than a paragraph split because the cell
 * stays one paragraph: a cell grows a line, not a block. That is also the wire
 * answer — a GFM pipe cell cannot hold a raw newline, and an inline hard break
 * has a spelling there already (`packages/markup`'s table codec writes it as a
 * trailing `\` and reads it back). A split would have had to invent one.
 *
 * There is one line break, reached two ways: this runs `setHardBreak`, the
 * same command TipTap's hard-break extension gives Shift-Enter everywhere, so
 * the two keys cannot drift apart inside a cell.
 *
 * Registering through the kernel rather than an `addKeyboardShortcuts` is what
 * keeps Enter's other owners intact without a guard here: a suggestion menu's
 * Enter sits at `layer` scope and answers first while it is open, and a
 * selected object inside a cell keeps object physics' engagement, because this
 * contribution narrows to the caret standing in the cell's own prose.
 */
import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";

import { getEditorChrome } from "../chrome/ChromeKernelExtension";
import type { KeymapBinding } from "../chrome/keymap";

const TABLE_ENTER_KEYMAP_NAME = "meridianTableEnterKeymap";

/**
 * A line break where the caret stands, and the key is consumed either way.
 *
 * Refuses anything that is not a caret or a range in the cell's inline content
 * — a swept rectangle of cells is the one that matters — because `setHardBreak`
 * inserts over the selection, and Enter must never be what empties four cells.
 * The refusal still keeps the key (`TabKeymapExtension`'s rule): below this sits
 * the base keymap, whose Enter would delete the same selection.
 */
function breakCellLine(editor: Editor): KeymapBinding {
  return (state) => {
    const { selection } = state;
    if (selection instanceof TextSelection && selection.$from.parent.inlineContent) {
      editor.commands.setHardBreak();
    }
    return true;
  };
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
            bindings: { Enter: breakCellLine(editor) },
          });
          return { destroy: () => release?.() };
        },
      }),
    ];
  },
});
