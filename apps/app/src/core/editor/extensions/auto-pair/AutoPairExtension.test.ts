// @vitest-environment jsdom
/**
 * Representative auto-pair behavior across gesture and editor-context boundaries.
 *
 * Every case here types real characters through the same `handleTextInput` path
 * a browser drives and presses real keys through the keymap, because the whole
 * feature is about what a keystroke becomes. The cases that matter most are the
 * refusals: a pair that fires where the writer did not want it, or a closing
 * keystroke that vanishes, costs far more than the convenience is worth.
 *
 * Explicit representative rows cover each context and gesture without deriving
 * the test cases from the production registry. Handwritten cases below cover
 * boundary rules around the caret, nesting, and gestures that degrade to plain
 * insertion.
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditor, type StandaloneEditor } from "@/test-support/standalone-editor";
import type { AutoPairContext } from "./auto-pairs";

const live: StandaloneEditor[] = [];

afterEach(() => {
  for (const fixture of live.splice(0)) fixture.destroy();
});

function openEditor(content = "<p></p>", schemaType: "document" | "code" = "document"): Editor {
  const fixture = createStandaloneEditor({ content, schemaType });
  live.push(fixture);
  const { editor } = fixture;
  editor.commands.focus("end");
  return editor;
}

/** Type character by character the way a browser reports composition-free input. */
function type(editor: Editor, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const insert = () => editor.state.tr.insertText(character, from, to);
    const handled = editor.view.someProp("handleTextInput", (handleTextInput) =>
      handleTextInput(editor.view, from, to, character, insert),
    );
    if (!handled) editor.view.dispatch(insert());
  }
}

/** One character reported as replacing `[from, to]` rather than landing at the caret. */
function typeOverRange(editor: Editor, from: number, to: number, character: string): boolean {
  return (
    editor.view.someProp("handleTextInput", (handleTextInput) =>
      handleTextInput(editor.view, from, to, character, () =>
        editor.state.tr.insertText(character, from, to),
      ),
    ) ?? false
  );
}

function press(editor: Editor, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  return (
    editor.view.someProp("handleKeyDown", (handleKeyDown) => handleKeyDown(editor.view, event)) ??
    false
  );
}

function caretAt(editor: Editor, parentOffset: number) {
  const { $from } = editor.state.selection;
  const position = $from.start() + parentOffset;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)),
  );
}

/** The caret's own block, with `|` standing where the caret is. */
function shape(editor: Editor): string {
  const { $from } = editor.state.selection;
  const text = $from.parent.textContent;
  return `${text.slice(0, $from.parentOffset)}|${text.slice($from.parentOffset)}`;
}

function fenceEditor(): Editor {
  const editor = openEditor("<p></p>");
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "code_block", attrs: { language: "python" }, content: [] }],
  });
  editor.commands.focus("end");
  return editor;
}

/** Explicit representative rows guard gesture behavior across editor contexts. */
type PairRow = {
  context: AutoPairContext;
  open: string;
  close: string;
  caretIn: () => Editor;
};
const BACKSPACE_ROWS: readonly PairRow[] = [
  { context: "prose", open: "[", close: "]", caretIn: () => openEditor() },
];

describe("representative registered pairs", () => {
  it.each(BACKSPACE_ROWS)("Backspace takes both halves of $open in $context", (row) => {
    const editor = row.caretIn();
    const room = shape(editor);
    type(editor, row.open);
    expect(press(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe(room);
  });
});

describe("what sits around the caret decides", () => {
  it("leaves a run of the same delimiter alone", () => {
    const editor = fenceEditor();
    type(editor, "```");

    expect(shape(editor)).toBe("```|");
  });
});

describe("typing the closer steps over the one that was written", () => {
  it("walks back out of both closers in order", () => {
    const editor = openEditor();
    type(editor, "[[]]");

    expect(shape(editor)).toBe("[[]]|");
  });

  it("writes a real bracket in front of one the writer typed themselves", () => {
    const editor = openEditor("<p>a]</p>");
    caretAt(editor, 1);
    type(editor, "]");

    expect(shape(editor)).toBe("a]|]");
  });

  it("degrades to plain insertion after the document is replaced wholesale", () => {
    const editor = openEditor();
    type(editor, "[");

    // What every remote collab edit does: y-prosemirror rebuilds the document,
    // so every tracked position is reported deleted and nothing may be stepped.
    editor.commands.setContent("<p>[]</p>");
    caretAt(editor, 1);
    type(editor, "]");

    expect(shape(editor)).toBe("[]|]");
  });
});

describe("a keystroke reported as a block replacement", () => {
  it("pairs into the empty block a select-all Backspace left behind", () => {
    const editor = openEditor("<p>Hello</p>");
    editor.commands.selectAll();
    editor.commands.deleteSelection();
    // The selection still spans the emptied document, which is the state the
    // writer's next character actually arrives in.
    editor.commands.selectAll();

    expect(typeOverRange(editor, 0, editor.state.doc.content.size, "[")).toBe(true);
    expect(shape(editor)).toBe("[|]");
  });

  it("stands aside when the writer is typing over their own selection", () => {
    const editor = openEditor("<p>Hello</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });

    expect(typeOverRange(editor, 1, 6, "[")).toBe(false);
  });
});

describe("the gesture is one transaction", () => {
  it("writes both halves in a single document change, so one undo takes them", () => {
    const editor = openEditor();
    let changes = 0;
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) changes += 1;
    });
    type(editor, "[");

    expect(changes).toBe(1);
    expect(shape(editor)).toBe("[|]");
  });
});
