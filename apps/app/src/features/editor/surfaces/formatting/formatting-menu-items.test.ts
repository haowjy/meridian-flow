// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { formattingMenuModel } from "./formatting-menu-items";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function editorWith(content: string | JSONContent): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

function modelFor(target: Editor) {
  return formattingMenuModel(target);
}

function posInsideType(target: Editor, typeName: string): number {
  let pos = -1;
  target.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === typeName) pos = at + 1;
  });
  if (pos < 0) throw new Error(`no ${typeName} in the document`);
  return pos;
}

const FENCE_DOC: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Kael pressed his palm flat" }] },
    {
      type: "code_block",
      attrs: { language: "mermaid" },
      content: [{ type: "text", text: "graph TD; A --> B" }],
    },
  ],
};

const TABLE_DOC: JSONContent = {
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "table_row",
          content: [
            {
              type: "table_cell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Kael" }] }],
            },
          ],
        },
      ],
    },
  ],
};

describe("what the formatting menu offers", () => {
  it("offers everything over a plain prose selection", () => {
    const target = editorWith("<p>He had rehearsed this in the shallows</p>");
    target.commands.setTextSelection({ from: 4, to: 12 });

    const model = modelFor(target);
    for (const [id, state] of Object.entries(model.marks)) {
      expect(state.blockedBy, id).toBeNull();
    }
    expect(model.turnIntoBlockedBy).toBeNull();
    expect(model.link.blockedBy).toBeNull();
  });

  it("lights the mark the selection already wears (law 6)", () => {
    const target = editorWith("<p>the <em>shallows</em> of the Vault</p>");
    target.commands.setTextSelection({ from: 5, to: 13 });

    const model = modelFor(target);
    expect(model.marks.italic.active).toBe(true);
    expect(model.marks.bold.active).toBe(false);
  });

  it("checks the block type the selection already is", () => {
    const target = editorWith("<h2>The Third Gate</h2>");
    target.commands.setTextSelection({ from: 1, to: 5 });

    const model = modelFor(target);
    expect(model.turnInto.heading2.active).toBe(true);
    expect(model.turnInto.paragraph.active).toBe(false);
  });

  it("greys the marks inline code excludes and keeps inline code removable", () => {
    const target = editorWith("<p>the <code>third</code> gate</p>");
    target.commands.setTextSelection({ from: 5, to: 10 });

    const model = modelFor(target);
    expect(model.marks.bold.blockedBy).toBe("inline-code");
    expect(model.marks.italic.blockedBy).toBe("inline-code");
    expect(model.marks.strike.blockedBy).toBe("inline-code");
    expect(model.link.blockedBy).toBe("inline-code");
    expect(model.marks.code.active).toBe(true);
    expect(model.marks.code.blockedBy).toBeNull();
  });

  it("greys Turn into as a whole inside a table cell rather than opening dead rows", () => {
    const target = editorWith(TABLE_DOC);
    const cell = posInsideType(target, "table_cell");
    target.commands.setTextSelection({ from: cell + 1, to: cell + 4 });

    const model = modelFor(target);
    expect(model.turnIntoBlockedBy).toBe("table-cell");
    // Cells are prose: the marks belong there.
    expect(model.marks.bold.blockedBy).toBeNull();
    expect(model.link.blockedBy).toBeNull();
  });

  it("refuses every conversion when a select-all catches a diagram (F6)", () => {
    const target = editorWith(FENCE_DOC);
    target.commands.selectAll();

    const model = modelFor(target);
    expect(model.turnIntoBlockedBy).toBe("mixed-selection");
    // Marks land per node, so the prose in the selection still formats.
    expect(model.marks.bold.blockedBy).toBeNull();
  });

  it("greys every verb but Copy on a document that turned read only", () => {
    const target = editorWith("<p>He had rehearsed this</p>");
    target.commands.setTextSelection({ from: 1, to: 4 });
    target.setEditable(false);

    const model = modelFor(target);
    expect(model.marks.bold.blockedBy).toBe("document-read-only");
    expect(model.turnIntoBlockedBy).toBe("document-read-only");
    expect(model.link.blockedBy).toBe("document-read-only");
  });
});
