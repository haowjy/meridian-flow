/**
 * The editor owns Tab and Shift-Tab, and never hands them back.
 *
 * Tab makes a tab. That is what a writer expects from every editor they have
 * come from, and it is the one thing the browser's own Tab refuses to be: its
 * Tab is a focus move. TipTap's table and list extensions bind the key where
 * they have something to do and REFUSE it everywhere else, and a refusal is a
 * leak — in a heading, in a paragraph, on the first list item, DOM focus lands
 * on the nearest button in the app chrome while the ProseMirror selection
 * stays where it was, and every keystroke after that is discarded in silence.
 *
 * So the rule is `UndoRedoKeymapExtension`'s: ownership that lapses on a
 * refusal is not ownership. Every binding here consumes its key, and the only
 * question is what it does with it, deepest owner first:
 *
 * - in a table, Tab walks cells — a grid has no room for indentation;
 * - in a code fence, it indents, line-wise when something is selected;
 * - in a list, it sinks or lifts the item, refusal included;
 * - anywhere else in prose, it inserts one tab character.
 *
 * Prose tabs reach the wire intact (law 9): a tab mid-line is literal
 * markdown, while a LEADING tab would parse back as an indented code block,
 * so the codec writes that one as `&#x9;` and reads it back as a tab. The
 * round trip is pinned in `packages/markup`'s codec test, which is what makes
 * this key safe to hand a writer.
 *
 * Registering through the kernel — rather than an `addKeyboardShortcuts` at
 * some priority number — is what puts those four cases on one ladder, and
 * what lets a future surface take Tab at `layer` scope while it is open
 * without touching this file.
 */
import { type Editor, Extension } from "@tiptap/core";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";

import { getEditorChrome } from "../chrome/ChromeKernelExtension";
import type { KeymapBinding } from "../chrome/keymap";
import { isSourceBlock } from "../objects/object-types";

const TAB_KEYMAP_NAME = "meridianTabKeymap";

/** What one press is worth. A tab, because the writer pressed Tab. */
const TAB = "\t";

/**
 * What one Shift-Tab takes back off a line: the tab this file inserts, or the
 * spaces pasted code arrives with.
 */
const OUTDENT = /^(\t| {1,4})/;

/**
 * Runs the verb and keeps the key whatever the verb decided.
 *
 * The refusals are the reason this extension exists, so they are not passed
 * down the ladder: below this sit TipTap's own Tab bindings, which refuse the
 * same cases, and below those is the browser.
 */
function consuming(
  verb: (editor: Editor, ...args: Parameters<KeymapBinding>) => void,
): (editor: Editor) => KeymapBinding {
  return (editor) => (state, dispatch, view) => {
    verb(editor, state, dispatch, view);
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

/**
 * Inside a list the key belongs to the list, refusal included: `sinkListItem`
 * has nothing to sink the first item under, and a tab in that bullet's text is
 * not what the writer asked for by pressing the indent key.
 */
const indentOrTab = consuming((editor, state, dispatch) => {
  if (insideListItem(state)) {
    editor.commands.sinkListItem("list_item");
    return;
  }
  insertTab(state, dispatch);
});

const outdentItem = consuming((editor, state) => {
  if (insideListItem(state)) editor.commands.liftListItem("list_item");
});

const indentFence = (direction: 1 | -1) =>
  consuming((_editor, state, dispatch) => {
    const transaction = fenceIndentTransaction(state, direction);
    if (transaction) dispatch?.(transaction);
  });

/**
 * One tab where the caret stands.
 *
 * Refuses anything that is not a caret or a range in inline content — a
 * selected object, a gap cursor, a whole-table cell selection — because
 * inserting text there replaces what is selected, and a key that means
 * "indent" must never be what deletes a picture. The caller consumes the key
 * either way.
 */
function insertTab(state: EditorState, dispatch: Parameters<KeymapBinding>[1]): void {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.$from.parent.inlineContent) return;
  dispatch?.(state.tr.insertText(TAB).scrollIntoView());
}

function insideListItem(state: EditorState): boolean {
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "list_item") return true;
  }
  return false;
}

/**
 * Indent or outdent the fence lines the selection touches.
 *
 * A caret takes one tab where it stands. Anything selected is line-wise: a
 * writer who swept three lines means those three lines rather than "replace
 * them with a tab", which is the one place a fence differs from prose.
 *
 * Null when there is nothing to do — a fence selected whole rather than typed
 * into, or a Shift-Tab on lines carrying no indentation.
 */
function fenceIndentTransaction(state: EditorState, direction: 1 | -1): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;

  const { $from, $to, empty } = selection;
  if (!$from.sameParent($to) || !isSourceBlock($from.parent)) return null;
  if (direction === 1 && empty) return state.tr.insertText(TAB).scrollIntoView();

  const start = $from.start();
  const text = $from.parent.textContent;
  const transaction = state.tr;

  // Back to front: an edit on an earlier line moves every position after it.
  for (const lineStart of touchedLineStarts(text, $from.pos - start, $to.pos - start).reverse()) {
    const at = start + lineStart;
    if (direction === 1) {
      transaction.insertText(TAB, at);
      continue;
    }
    const indent = OUTDENT.exec(text.slice(lineStart))?.[0].length ?? 0;
    if (indent > 0) transaction.delete(at, at + indent);
  }

  return transaction.docChanged ? transaction.scrollIntoView() : null;
}

/** Offsets of the line starts a `from`–`to` range within `text` reaches. */
function touchedLineStarts(text: string, from: number, to: number): number[] {
  const starts: number[] = [];

  for (let start = from === 0 ? 0 : text.lastIndexOf("\n", from - 1) + 1; start <= to; ) {
    // A range that ends exactly at a line's start never reached that line.
    if (start === to && start !== from) break;
    starts.push(start);
    const lineBreak = text.indexOf("\n", start);
    if (lineBreak === -1) break;
    start = lineBreak + 1;
  }

  return starts;
}

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
              id: "tab-fence",
              scope: "block",
              // The scope says where it is live; this says which block it is
              // about, which is the narrowing `appliesTo` exists for.
              appliesTo: (context) => context.chain.includes("source-block"),
              bindings: { Tab: indentFence(1)(editor), "Shift-Tab": indentFence(-1)(editor) },
            }),
            chrome?.registerKeymap({
              id: "tab-indent",
              scope: "document",
              bindings: { Tab: indentOrTab(editor), "Shift-Tab": outdentItem(editor) },
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
