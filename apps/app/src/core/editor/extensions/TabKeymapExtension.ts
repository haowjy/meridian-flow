/**
 * The editor owns Tab and Shift-Tab, and never hands them back.
 *
 * Tab is the indent key everywhere a writer has come from — Word, Docs,
 * Scrivener, Notion — but the browser's own Tab is a focus move. TipTap's
 * table and list extensions bind it where they have something to do and
 * REFUSE it everywhere else, and a refusal is a leak: in a heading, in a
 * paragraph, on the first list item (`sinkListItem` has nothing to sink
 * under) the key reaches the browser, DOM focus lands on the nearest button
 * in the app chrome, the ProseMirror selection stays where it was, and every
 * keystroke after that is discarded in silence.
 *
 * So the rule is `UndoRedoKeymapExtension`'s: ownership that lapses on a
 * refusal is not ownership. Where indent or cell-walk means something, do it;
 * everywhere else consume the key as a no-op. The writer's caret is still in
 * the document either way, which is the whole point.
 *
 * The two bindings sit at their own scopes rather than at one, so the ladder
 * says what it means: a table cell walks cells (deepest owner), and a caret
 * anywhere else indents a list or does nothing. Registering through the
 * kernel — rather than an `addKeyboardShortcuts` at some priority number —
 * is also what lets a future surface take Tab at `layer` scope while it is
 * open without touching this file.
 */
import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { getEditorChrome } from "../chrome/ChromeKernelExtension";
import type { KeymapBinding } from "../chrome/keymap";

const TAB_KEYMAP_NAME = "meridianTabKeymap";

/**
 * Runs the verb and keeps the key whatever the verb decided.
 *
 * The refusals are the reason this extension exists, so they are not passed
 * down the ladder: below this sit TipTap's own Tab bindings, which refuse the
 * same cases, and below those is the browser.
 */
function consuming(verb: (editor: Editor) => void): (editor: Editor) => KeymapBinding {
  return (editor) => () => {
    verb(editor);
    return true;
  };
}

/**
 * Tab in a cell walks to the next one, and grows the table rather than
 * stopping at the last cell — prosemirror-tables has no row to walk into, and
 * a writer filling a table in expects one.
 */
const nextCell = consuming((editor) => {
  if (editor.commands.goToNextCell()) return;
  if (editor.can().addRowAfter()) editor.chain().addRowAfter().goToNextCell().run();
});

const previousCell = consuming((editor) => {
  editor.commands.goToPreviousCell();
});

const sinkItem = consuming((editor) => {
  editor.commands.sinkListItem("list_item");
});

const liftItem = consuming((editor) => {
  editor.commands.liftListItem("list_item");
});

export const TabKeymapExtension = Extension.create({
  name: TAB_KEYMAP_NAME,

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey(TAB_KEYMAP_NAME),
        // Registration rides the plugin's view lifetime, like object physics:
        // TipTap's `create` event is a macrotask late, which is long enough
        // for a first Tab to miss it.
        view: () => {
          const chrome = getEditorChrome(editor);
          const releases = [
            chrome?.registerKeymap({
              id: "tab-table",
              scope: "table",
              bindings: { Tab: nextCell(editor), "Shift-Tab": previousCell(editor) },
            }),
            chrome?.registerKeymap({
              id: "tab-indent",
              scope: "document",
              bindings: { Tab: sinkItem(editor), "Shift-Tab": liftItem(editor) },
            }),
          ];
          return {
            destroy() {
              for (const release of releases) release?.();
            },
          };
        },
      }),
    ];
  },
});
