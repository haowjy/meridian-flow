// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { chromeContextAt, resolveChromeContext } from "./chrome-context";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const cell = (text: string): JSONContent => ({
  type: "table_cell",
  content: [paragraph(text)],
});

function mount(content: JSONContent[]): Editor {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}

/** First position inside the node of `type`, the way a caret lands there. */
function caretInside(instance: Editor, type: string): number {
  let found: number | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === type) found = pos + 1;
    return found === null;
  });
  if (found === null) throw new Error(`no ${type} in the fixture`);
  return found;
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

function selectText(instance: Editor, pos: number) {
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.near(instance.state.doc.resolve(pos))),
  );
}

describe("resolveChromeContext", () => {
  it("owns nothing above the document when the caret is in prose", () => {
    const instance = mount([paragraph("The third gate opened.")]);
    selectText(instance, 2);

    expect(resolveChromeContext(instance.state)).toEqual({
      owner: "document",
      nodeType: null,
      objectSpec: null,
      pos: null,
      chain: ["document"],
      objectPos: null,
    });
  });

  it("gives a caret in a cell to the cell, with the table above it in the chain", () => {
    const instance = mount([
      {
        type: "table",
        content: [{ type: "table_row", content: [cell("Rank"), cell("Skill")] }],
      },
    ]);
    selectText(instance, caretInside(instance, "table_cell") + 1);

    const context = resolveChromeContext(instance.state);
    expect(context.owner).toBe("table-cell");
    expect(context.chain).toEqual(["document", "table", "table-cell"]);
    expect(context.nodeType).toBe("table_cell");
    // The table is the object the caret stands inside: Esc's first step out.
    expect(context.objectPos).toBe(0);
  });

  it("gives a caret in a code fence to the source block", () => {
    const instance = mount([
      { type: "code_block", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
    ]);
    selectText(instance, caretInside(instance, "code_block"));

    const context = resolveChromeContext(instance.state);
    expect(context.owner).toBe("source-block");
    expect(context.chain).toEqual(["document", "source-block"]);
  });

  it("gives a selected figure to the object register", () => {
    const instance = mount([
      paragraph("before"),
      { type: "figure", attrs: { src: "asset:1", caption: "" } },
    ]);
    const pos = positionOf(instance, "figure");
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, pos)),
    );

    expect(resolveChromeContext(instance.state)).toEqual({
      owner: "object",
      nodeType: "figure",
      // The registration, not the node type: what a per-object keymap matches.
      objectSpec: "figure",
      pos,
      chain: ["document", "object"],
      objectPos: null,
    });
  });

  it("gives a SELECTED plain fence to the source block, not to the document", () => {
    const instance = mount([
      paragraph("before"),
      { type: "code_block", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
    ]);
    const pos = positionOf(instance, "code_block");
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, pos)),
    );

    // Reporting the document here left Esc with nothing to walk out of and
    // handed Enter to the base keymap.
    const context = resolveChromeContext(instance.state);
    expect(context.owner).toBe("source-block");
    expect(context.pos).toBe(pos);
    expect(context.nodeType).toBe("code_block");
  });

  it("treats a selected mermaid fence as an object, not a source block", () => {
    const instance = mount([
      {
        type: "code_block",
        attrs: { language: "mermaid" },
        content: [{ type: "text", text: "graph TD;" }],
      },
    ]);
    const pos = positionOf(instance, "code_block");
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, pos)),
    );

    const context = resolveChromeContext(instance.state);
    expect(context.owner).toBe("object");
    expect(context.nodeType).toBe("code_block");
  });
});

describe("chromeContextAt", () => {
  it("reads what the POINTER is over, not what the selection is in", () => {
    const instance = mount([
      paragraph("The third gate opened."),
      { type: "figure", attrs: { src: "asset:1", caption: "" } },
    ]);
    selectText(instance, 2);

    const figurePos = positionOf(instance, "figure");
    expect(chromeContextAt(instance.state.doc, figurePos).owner).toBe("object");
    expect(resolveChromeContext(instance.state).owner).toBe("document");
  });

  it("clamps a position past the end of the document rather than throwing", () => {
    const instance = mount([paragraph("short")]);
    expect(chromeContextAt(instance.state.doc, 9_999).owner).toBe("document");
  });
});
