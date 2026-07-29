// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import {
  caretBesideObjectTransaction,
  caretHomeFromObjectTransaction,
  caretInsideObjectTransaction,
  objectBeside,
  selectedObject,
  selectObjectTransaction,
} from "./object-selection";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const figure: JSONContent = { type: "figure", attrs: { src: "asset:1", caption: "" } };

const inlineImage: JSONContent = {
  type: "paragraph",
  content: [
    { type: "text", text: "see " },
    { type: "image", attrs: { src: "asset:2" } },
    { type: "text", text: " here" },
  ],
};

function mount(content: JSONContent[]): Editor {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}

function positionOf(instance: Editor, type: string): number {
  let found: number | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === type) found = pos;
    return found === null;
  });
  if (found === null) throw new Error(`no ${type} in the fixture`);
  return found;
}

function caretAt(instance: Editor, pos: number) {
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, pos)),
  );
}

describe("walking onto an object", () => {
  it("finds the block object after a caret at the end of the paragraph", () => {
    const instance = mount([paragraph("before"), figure, paragraph("after")]);
    caretAt(instance, "before".length + 1);

    expect(objectBeside(instance.state, 1)?.node.type.name).toBe("figure");
  });

  it("does not leap out of the sentence from mid-paragraph", () => {
    const instance = mount([paragraph("before"), figure]);
    caretAt(instance, 3);

    expect(objectBeside(instance.state, 1)).toBeNull();
  });

  it("finds the block object before a caret at the start of the paragraph", () => {
    const instance = mount([paragraph("before"), figure, paragraph("after")]);
    caretAt(instance, positionOf(instance, "figure") + 2);

    expect(objectBeside(instance.state, -1)?.node.type.name).toBe("figure");
  });

  it("stops at a paragraph rather than reaching past it for an object", () => {
    const instance = mount([paragraph("before"), paragraph("between"), figure]);
    caretAt(instance, "before".length + 1);

    expect(objectBeside(instance.state, 1)).toBeNull();
  });

  it("finds an inline image beside the caret inside its own paragraph", () => {
    const instance = mount([inlineImage]);
    caretAt(instance, 1 + "see ".length);

    const beside = objectBeside(instance.state, 1);
    expect(beside?.node.type.name).toBe("image");
    expect(beside?.pos).toBe(positionOf(instance, "image"));
  });

  it("walks nothing while a selection is being made", () => {
    const instance = mount([paragraph("before"), figure]);
    instance.view.dispatch(
      instance.state.tr.setSelection(TextSelection.create(instance.state.doc, 1, 4)),
    );

    expect(objectBeside(instance.state, 1)).toBeNull();
  });
});

describe("selecting and leaving an object", () => {
  it("selects a figure and reports it as the object under the selection", () => {
    const instance = mount([paragraph("before"), figure]);
    const pos = positionOf(instance, "figure");

    const transaction = selectObjectTransaction(instance.state, pos);
    expect(transaction).not.toBeNull();
    if (transaction) instance.view.dispatch(transaction);

    expect(selectedObject(instance.state)).toMatchObject({ pos });
    expect(instance.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("refuses to select a paragraph: prose is not an object", () => {
    const instance = mount([paragraph("before")]);
    expect(selectObjectTransaction(instance.state, 0)).toBeNull();
  });

  it("puts the caret after the object when walking past it", () => {
    const instance = mount([paragraph("before"), figure, paragraph("after")]);
    const pos = positionOf(instance, "figure");

    const transaction = caretBesideObjectTransaction(instance.state, pos, 1);
    if (transaction) instance.view.dispatch(transaction);

    expect(instance.state.selection.empty).toBe(true);
    expect(instance.state.selection.$head.parent.textContent).toBe("after");
  });

  it("puts the caret before the object when walking back over it", () => {
    const instance = mount([paragraph("before"), figure, paragraph("after")]);
    const pos = positionOf(instance, "figure");

    const transaction = caretBesideObjectTransaction(instance.state, pos, -1);
    if (transaction) instance.view.dispatch(transaction);

    expect(instance.state.selection.$head.parent.textContent).toBe("before");
  });

  it("engages a table by dropping the caret in its first cell", () => {
    const instance = mount([
      {
        type: "table",
        content: [
          {
            type: "table_row",
            content: [
              { type: "table_header", content: [paragraph("Rank")] },
              { type: "table_header", content: [paragraph("Skill")] },
            ],
          },
        ],
      },
    ]);
    const pos = positionOf(instance, "table");

    const transaction = caretInsideObjectTransaction(instance.state, pos);
    expect(transaction).not.toBeNull();
    if (transaction) instance.view.dispatch(transaction);

    expect(instance.state.selection.$head.parent.textContent).toBe("Rank");
  });

  it("has nothing to engage inside an atom", () => {
    const instance = mount([figure]);
    expect(caretInsideObjectTransaction(instance.state, positionOf(instance, "figure"))).toBeNull();
  });

  it("reports a dead end rather than walking the other way", () => {
    const instance = mount([paragraph("before"), figure]);
    expect(
      caretBesideObjectTransaction(instance.state, positionOf(instance, "figure"), 1),
    ).toBeNull();
  });

  it("makes a home when the object IS the document, rather than trapping", () => {
    const instance = mount([figure]);
    const pos = positionOf(instance, "figure");

    const transaction = caretHomeFromObjectTransaction(instance.state, pos);
    // There is no prose either side, so law 3 has nowhere to walk to. Writing
    // one paragraph is a smaller cost than a writer standing on a thing they
    // asked to leave.
    expect(transaction).not.toBeNull();
    if (transaction) instance.view.dispatch(transaction);

    expect(instance.state.selection.empty).toBe(true);
    expect(instance.state.selection.$head.parent.type.name).toBe("paragraph");
    expect(instance.state.doc.childCount).toBe(2);
  });

  it("makes a home out of a lone source block too", () => {
    const instance = mount([
      { type: "code_block", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
    ]);
    const pos = positionOf(instance, "code_block");

    const transaction = caretHomeFromObjectTransaction(instance.state, pos);
    expect(transaction).not.toBeNull();
    if (transaction) instance.view.dispatch(transaction);

    expect(instance.state.selection.$head.parent.type.name).toBe("paragraph");
  });

  it("sends Esc home in front of an object that ends the document", () => {
    const instance = mount([paragraph("before"), figure]);
    const transaction = caretHomeFromObjectTransaction(
      instance.state,
      positionOf(instance, "figure"),
    );

    expect(transaction).not.toBeNull();
    if (transaction) instance.view.dispatch(transaction);
    expect(instance.state.selection.$head.parent.textContent).toBe("before");
  });
});
