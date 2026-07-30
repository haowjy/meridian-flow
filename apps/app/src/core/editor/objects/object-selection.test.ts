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
  typeBesideObjectTransaction,
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

  describe("never lands behind the object it left", () => {
    const successors: [string, JSONContent][] = [
      ["a scene break", { type: "horizontal_rule" }],
      ["a figure", { type: "figure", attrs: { src: "asset:2", caption: "" } }],
      [
        "a table",
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
      ],
      [
        "another diagram",
        {
          type: "code_block",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: "graph LR;" }],
        },
      ],
      [
        "a paragraph holding an inline image",
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            { type: "image", attrs: { src: "asset:3" } },
          ],
        },
      ],
    ];

    for (const [label, successor] of successors) {
      it(`walks forward past ${label}`, () => {
        const diagram: JSONContent = {
          type: "code_block",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: "graph TD;" }],
        };
        const instance = mount([paragraph("before"), diagram, successor, paragraph("tail")]);
        const pos = positionOf(instance, "code_block");

        const transaction = caretHomeFromObjectTransaction(instance.state, pos);
        expect(transaction).not.toBeNull();
        if (transaction) instance.view.dispatch(transaction);

        // The whole failure mode in one assertion: a leaf successor used to
        // send Esc backward, and the next keystroke edited the block above.
        expect(instance.state.selection.from).toBeGreaterThan(pos);
        expect(instance.state.selection.empty).toBe(true);
      });
    }
  });

  describe("a leaf that ends the document", () => {
    const diagram: JSONContent = {
      type: "code_block",
      attrs: { language: "mermaid" },
      content: [{ type: "text", text: "graph TD;" }],
    };

    it("lands in the gap past it, not in the block above", () => {
      const instance = mount([paragraph("before"), diagram, { type: "horizontal_rule" }]);
      const pos = positionOf(instance, "code_block");

      const transaction = caretHomeFromObjectTransaction(instance.state, pos);
      expect(transaction).not.toBeNull();
      if (transaction) instance.view.dispatch(transaction);

      // No text position exists past a trailing scene break, and the
      // "object ends the document" fallback used to fire for an object that
      // does not — sending the caret into the paragraph ABOVE the diagram.
      // With gapcursor installed the gap after the leaf is a real home.
      expect(instance.state.selection.from).toBeGreaterThan(pos);
    });

    it("still prefers real text when some follows the leaf", () => {
      const instance = mount([
        paragraph("before"),
        diagram,
        { type: "horizontal_rule" },
        paragraph("tail"),
      ]);
      const pos = positionOf(instance, "code_block");

      const transaction = caretHomeFromObjectTransaction(instance.state, pos);
      if (transaction) instance.view.dispatch(transaction);

      expect(instance.state.selection.$head.parent.textContent).toBe("tail");
    });
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

/**
 * The walk crosses a rendered diagram as ONE thing (human ruling, 2026-07-30:
 * "it should just select the svg, never reveal").
 *
 * Every case here starts ON an object, which is the half of the walk that used
 * to ask ProseMirror rather than the registration: a `code_block` is a
 * textblock, so the step beside a scene break landed in the mermaid source and
 * the fence traded its picture for its syntax.
 */
describe("stepping beside an object that stands next to another", () => {
  const diagram = (source: string): JSONContent => ({
    type: "code_block",
    attrs: { language: "mermaid" },
    content: [{ type: "text", text: source }],
  });
  const rule: JSONContent = { type: "horizontal_rule" };
  const grid: JSONContent = {
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
  };

  function walk(instance: Editor, from: string, direction: 1 | -1) {
    const transaction = caretBesideObjectTransaction(
      instance.state,
      positionOf(instance, from),
      direction,
    );
    expect(transaction).not.toBeNull();
    if (transaction) instance.view.dispatch(transaction);
  }

  it("selects the diagram above rather than opening its source", () => {
    const instance = mount([paragraph("before"), diagram("graph TD;"), rule, paragraph("after")]);
    walk(instance, "horizontal_rule", -1);

    expect(selectedObject(instance.state)?.pos).toBe(positionOf(instance, "code_block"));
    expect(instance.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("selects the diagram below the same way", () => {
    const instance = mount([paragraph("before"), rule, diagram("graph TD;"), paragraph("after")]);
    walk(instance, "horizontal_rule", 1);

    expect(selectedObject(instance.state)?.pos).toBe(positionOf(instance, "code_block"));
  });

  it("steps from one diagram onto the next", () => {
    const instance = mount([paragraph("before"), diagram("graph TD;"), diagram("graph LR;")]);
    const first = positionOf(instance, "code_block");
    walk(instance, "code_block", 1);

    expect(selectedObject(instance.state)?.pos).toBeGreaterThan(first);
    expect(instance.state.selection.$head.parent.type.name).not.toBe("code_block");
  });

  it("selects a table whole, as the walk out of prose already does", () => {
    const instance = mount([paragraph("before"), grid, rule, paragraph("after")]);
    walk(instance, "horizontal_rule", -1);

    // A table is selected as a CellSelection over every cell, which is the
    // only spelling this schema has for "the table is selected".
    expect(selectedObject(instance.state)?.node.type.name).toBe("table");
  });

  it("still hands a plain fence its caret: its text is what the page shows", () => {
    const instance = mount([
      paragraph("before"),
      { type: "code_block", attrs: { language: "ts" }, content: [{ type: "text", text: "x = 1" }] },
      rule,
    ]);
    walk(instance, "horizontal_rule", -1);

    expect(instance.state.selection.empty).toBe(true);
    expect(instance.state.selection.$head.parent.textContent).toBe("x = 1");
  });

  it("sends Esc past a diagram rather than into its source", () => {
    const instance = mount([paragraph("before"), rule, diagram("graph TD;"), paragraph("after")]);
    const transaction = caretHomeFromObjectTransaction(
      instance.state,
      positionOf(instance, "horizontal_rule"),
    );
    expect(transaction).not.toBeNull();
    if (transaction) instance.view.dispatch(transaction);

    expect(instance.state.selection.$head.parent.textContent).toBe("after");
  });

  it("types beside the object rather than into the diagram's source", () => {
    const instance = mount([paragraph("before"), rule, diagram("graph TD;"), paragraph("after")]);
    const transaction = typeBesideObjectTransaction(
      instance.state,
      positionOf(instance, "horizontal_rule"),
      "q",
    );
    expect(transaction).not.toBeNull();
    if (transaction) instance.view.dispatch(transaction);

    // The letter belongs where the writer was looking: a paragraph made
    // between the scene break and the picture, not inside the picture.
    expect(instance.state.selection.$head.parent.type.name).toBe("paragraph");
    expect(instance.state.selection.$head.parent.textContent).toBe("q");
    expect(instance.state.doc.nodeAt(positionOf(instance, "code_block"))?.textContent).toBe(
      "graph TD;",
    );
  });
});
