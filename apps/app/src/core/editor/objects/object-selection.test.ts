// @vitest-environment jsdom
import type { Editor, JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { installJsdomLayout } from "@/test-support/jsdom-layout";

import {
  createStandaloneEditor,
  requireNode,
  type StandaloneEditor,
} from "@/test-support/standalone-editor";
import { caretHomeFromObjectTransaction, typeBesideObjectTransaction } from "./object-selection";

let fixture: StandaloneEditor | null = null;

// Arrow keys reach gapcursor, which measures the line to decide whether Down
// leaves the block. jsdom cannot measure.
installJsdomLayout();

afterEach(() => {
  fixture?.destroy();
  fixture = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

function mount(content: JSONContent[]): Editor {
  fixture = createStandaloneEditor({ content: { type: "doc", content } });
  return fixture.editor;
}

function positionOf(instance: Editor, type: string): number {
  return requireNode(instance, type).pos;
}

/**
 * A cell is isolating, and every landing these transactions compute has to
 * respect that (§5a of the cell addendum): the position after a block that
 * ends a cell exists, but the nearest text FORWARD of it is the neighbouring
 * cell's — which is never the answer.
 */
describe("leaving a block that ends its cell", () => {
  const fenceTs: JSONContent = {
    type: "code_block",
    attrs: { language: "ts" },
    content: [{ type: "text", text: "const gate = 3;" }],
  };
  const diagram: JSONContent = {
    type: "code_block",
    attrs: { language: "mermaid" },
    content: [{ type: "text", text: "graph TD;" }],
  };
  const twoCells = (first: JSONContent[], second: JSONContent[]): JSONContent => ({
    type: "table",
    content: [
      {
        type: "table_row",
        content: [
          { type: "table_cell", content: first },
          { type: "table_cell", content: second },
        ],
      },
    ],
  });

  function firstCellRange(instance: Editor): { start: number; end: number } {
    let found: { start: number; end: number } | null = null;
    instance.state.doc.descendants((node, pos) => {
      if (found === null && node.type.name === "table_cell") {
        found = { start: pos + 1, end: pos + 1 + node.content.size };
      }
      return found === null;
    });
    if (!found) throw new Error("no cell in the fixture");
    return found;
  }

  it("makes a home inside a cell whose only child is a fence", () => {
    const instance = mount([
      paragraph("before"),
      twoCells([fenceTs], [paragraph("neighbour")]),
      paragraph("after"),
    ]);
    const pos = positionOf(instance, "code_block");

    const transaction = caretHomeFromObjectTransaction(instance.state, pos);
    expect(transaction).not.toBeNull();
    if (transaction) instance.view.dispatch(transaction);

    // No prose either side inside the cell: one paragraph is made there, the
    // same answer a lone fence gets at the top level — and the neighbouring
    // cell is untouched.
    const cell = firstCellRange(instance);
    expect(instance.state.selection.from).toBeGreaterThanOrEqual(cell.start);
    expect(instance.state.selection.from).toBeLessThanOrEqual(cell.end);
    expect(instance.state.selection.$head.parent.type.name).toBe("paragraph");
  });

  it("types beside a selected diagram into its own cell, never the neighbour's", () => {
    const instance = mount([
      paragraph("before"),
      twoCells([diagram], [paragraph("neighbour")]),
      paragraph("after"),
    ]);
    const pos = positionOf(instance, "code_block");

    const transaction = typeBesideObjectTransaction(instance.state, pos, "Q");
    expect(transaction).not.toBeNull();
    if (transaction) instance.view.dispatch(transaction);

    const cell = firstCellRange(instance);
    expect(instance.state.selection.from).toBeGreaterThanOrEqual(cell.start);
    expect(instance.state.selection.from).toBeLessThanOrEqual(cell.end);
    expect(instance.state.selection.$head.parent.textContent).toBe("Q");
  });
});
