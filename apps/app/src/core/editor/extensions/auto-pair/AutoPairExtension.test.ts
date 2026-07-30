// @vitest-environment jsdom
/**
 * The auto-pair truth table, derived from the registry it is about.
 *
 * Every case here types real characters through the same `handleTextInput` path
 * a browser drives and presses real keys through the keymap, because the whole
 * feature is about what a keystroke becomes. The cases that matter most are the
 * refusals: a pair that fires where the writer did not want it, or a closing
 * keystroke that vanishes, costs far more than the convenience is worth.
 *
 * The mechanism rows come from `EDITOR_AUTO_PAIRS` itself — every row in every
 * context it declares, and every context it leaves out — so a new pair is one
 * production edit and arrives with opener, step-over, Backspace, and
 * wrong-context coverage already. What is written out by hand below is what the
 * registry cannot say: the boundary rules around the caret, nesting, and the
 * gestures that degrade to plain insertion.
 */
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../../config";
import { autoClosedRunLength } from "./AutoPairExtension";
import { type AutoPairContext, EDITOR_AUTO_PAIRS } from "./auto-pairs";

const live: Editor[] = [];

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
});

function openEditor(content = "<p></p>", schemaType: "document" | "code" = "document"): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions({ schemaType }),
    content,
  });
  live.push(editor);
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

/**
 * A caret inside an inline code span, with room on both sides of it.
 *
 * The span holds a single space so the derived rows measure the CONTEXT and
 * nothing else: a letter behind the caret would refuse every same-character
 * pair on its own (`6"` is inches), and a letter in front would refuse them all.
 */
function codeSpanEditor(): Editor {
  const editor = openEditor();
  editor.commands.setContent({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", marks: [{ type: "code" }], text: " " }] },
    ],
  });
  editor.commands.focus("end");
  return editor;
}

/** Every context a pair can be declared in, and how a writer stands in it. */
const CONTEXT_FIXTURES: readonly { context: AutoPairContext; caretIn: () => Editor }[] = [
  { context: "prose", caretIn: () => openEditor() },
  { context: "code-fence", caretIn: fenceEditor },
  { context: "inline-code", caretIn: codeSpanEditor },
];

type PairRow = {
  context: AutoPairContext;
  open: string;
  close: string;
  caretIn: () => Editor;
};

function rowsWhere(declared: boolean): readonly PairRow[] {
  return CONTEXT_FIXTURES.flatMap(({ context, caretIn }) =>
    EDITOR_AUTO_PAIRS.filter((pair) => pair.contexts.includes(context) === declared).map(
      ({ open, close }) => ({ context, open, close, caretIn }),
    ),
  );
}

const DECLARED_ROWS = rowsWhere(true);
const OMITTED_ROWS = rowsWhere(false);

describe("every registered pair, in every context it declares", () => {
  it.each(DECLARED_ROWS)("$open writes its closer in $context", ({ open, close, caretIn }) => {
    const editor = caretIn();
    const room = shape(editor);
    type(editor, open);

    expect(shape(editor)).toBe(room.replace("|", `${open}|${close}`));
  });

  it.each(DECLARED_ROWS)("$close steps over the closer written in $context", (row) => {
    const editor = row.caretIn();
    const room = shape(editor);
    type(editor, row.open + row.close);

    expect(shape(editor)).toBe(room.replace("|", `${row.open}${row.close}|`));
  });

  it.each(DECLARED_ROWS)("Backspace takes both halves of $open in $context", (row) => {
    const editor = row.caretIn();
    const room = shape(editor);
    type(editor, row.open);

    expect(press(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe(room);
  });
});

describe("a context a pair leaves out is a decision", () => {
  it.each(OMITTED_ROWS)("$open stays a plain character in $context", ({ open, caretIn }) => {
    const editor = caretIn();
    const room = shape(editor);
    type(editor, open);

    expect(shape(editor)).toBe(room.replace("|", `${open}|`));
  });
});

describe("what sits around the caret decides", () => {
  it("stands aside in front of a word the writer is wrapping", () => {
    const editor = openEditor("<p>Hello</p>");
    caretAt(editor, 0);
    type(editor, "(");

    expect(shape(editor)).toBe("(|Hello");
  });

  it("closes in front of the whitespace that follows it", () => {
    const editor = openEditor("<p>x y</p>");
    caretAt(editor, 1);
    type(editor, "(");

    expect(shape(editor)).toBe("x(|) y");
  });

  it("stands aside in front of the word a quote would swallow", () => {
    const editor = openEditor("<p>said and</p>");
    caretAt(editor, 5);
    type(editor, '"');

    expect(shape(editor)).toBe('said "|and');
  });

  it("leaves an apostrophe alone in prose, where it is a letter", () => {
    const editor = openEditor();
    type(editor, "don't stop");

    expect(shape(editor)).toBe("don't stop|");
  });

  it("leaves the backtick to the markdown code rule in prose", () => {
    const editor = openEditor();
    type(editor, "`spin`");

    expect(editor.state.doc.firstChild?.textContent).toBe("spin");
    expect(editor.state.doc.firstChild?.child(0).marks.map((mark) => mark.type.name)).toEqual([
      "code",
    ]);
  });

  it("leaves a run of the same delimiter alone", () => {
    const editor = fenceEditor();
    type(editor, "```");

    expect(shape(editor)).toBe("```|");
  });

  it("opens a docstring rather than three empty pairs", () => {
    const editor = fenceEditor();
    type(editor, '"""');

    expect(shape(editor)).toBe('"""|');
  });
});

describe("typing the closer steps over the one that was written", () => {
  it("composes a second opener into a nested pair", () => {
    const editor = openEditor();
    type(editor, "[[");

    expect(shape(editor)).toBe("[[|]]");
  });

  it("walks back out of both closers in order", () => {
    const editor = openEditor();
    type(editor, "[[]]");

    expect(shape(editor)).toBe("[[]]|");
  });

  it("carries a name between the brackets", () => {
    const editor = openEditor();
    type(editor, "[[The Third Gate]]");

    expect(shape(editor)).toBe("[[The Third Gate]]|");
  });

  it("writes a real bracket in front of one the writer typed themselves", () => {
    const editor = openEditor("<p>a]</p>");
    caretAt(editor, 1);
    type(editor, "]");

    expect(shape(editor)).toBe("a]|]");
  });

  it("steps only at the caret the closer was written for", () => {
    const editor = openEditor();
    type(editor, "[");
    caretAt(editor, 2);
    type(editor, "]");

    expect(shape(editor)).toBe("[]]|");
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
  it("pairs when the reported range carries no text", () => {
    const editor = openEditor();

    // The browser swapped an empty paragraph's trailing `<br>` for the
    // character, so ProseMirror reads the diff back as the whole block being
    // replaced. Live, this is the first character typed into an empty
    // paragraph, and it stopped pairing entirely when the caret was ignored.
    expect(typeOverRange(editor, 0, editor.state.doc.content.size, "[")).toBe(true);
    expect(shape(editor)).toBe("[|]");
  });

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

describe("Backspace between the halves takes both", () => {
  it("unwraps one level of a nested pair", () => {
    const editor = openEditor();
    type(editor, "[[");

    expect(press(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toBe("[|]");
  });

  // Backspace over a plain character is the browser's own, so what these two
  // assert is the handoff: the key is refused and the rest of the chain has it.
  it("hands the key on when the caret is not between the halves", () => {
    const editor = openEditor();
    type(editor, "[]");

    expect(press(editor, "Backspace")).toBe(false);
    expect(shape(editor)).toBe("[]|");
  });

  it("hands the key on once the document has been replaced", () => {
    const editor = openEditor();
    type(editor, "[");

    editor.commands.setContent("<p>[]</p>");
    caretAt(editor, 1);

    expect(press(editor, "Backspace")).toBe(false);
    expect(shape(editor)).toBe("[|]");
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

describe("the registry", () => {
  // Their completion path is the markdown autoformat, which needs the closing
  // run typed rather than written ahead of it.
  it.each(["*", "_", "~"])("leaves the autoformat's own %s unpaired", (delimiter) => {
    expect(EDITOR_AUTO_PAIRS.map((pair) => pair.open)).not.toContain(delimiter);
  });

  it("counts the closers a range replacement has to swallow", () => {
    const editor = openEditor();
    type(editor, "[[Gate");

    expect(autoClosedRunLength(editor.state, editor.state.selection.from)).toBe(2);
  });
});
