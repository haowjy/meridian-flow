// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import {
  documentToolbarControls,
  setToolbarAlignment,
  type ToolbarContext,
  toggleHeadingBlock,
  toggleTextMark,
  turnIntoBlockType,
} from "./toolbar-commands";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function editorWith(content: string | JSONContent): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

function controlsFor(target: Editor | null, overrides: Partial<ToolbarContext> = {}) {
  return documentToolbarControls({
    editor: target,
    editable: true,
    schemaType: "document",
    canUndo: false,
    canRedo: false,
    imageUploadAvailable: true,
    ...overrides,
  });
}

function selectNodeOfType(target: Editor, typeName: string): void {
  let pos = -1;
  target.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === typeName) pos = at;
  });
  if (pos < 0) throw new Error(`no ${typeName} in the document`);
  target.commands.setNodeSelection(pos);
}

const FIGURE_DOC: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "prose" }] },
    { type: "figure", attrs: { src: "asset:figure-1", alt: "the third gate" } },
  ],
};

/** Every cell position in document order. */
function cellPositions(target: Editor): number[] {
  const positions: number[] = [];
  target.state.doc.descendants((node, at) => {
    const role = node.type.spec.tableRole;
    if (role === "cell" || role === "header_cell") positions.push(at);
  });
  return positions;
}

function selectCells(target: Editor, anchor: number, head: number): void {
  target.view.dispatch(
    target.state.tr.setSelection(CellSelection.create(target.state.doc, anchor, head)),
  );
}

describe("block-type commands refuse non-text targets", () => {
  it("never converts a selected figure into a heading", () => {
    const target = editorWith(FIGURE_DOC);
    selectNodeOfType(target, "figure");

    expect(toggleHeadingBlock(target)).toBe(false);
    expect(target.state.doc.lastChild?.type.name).toBe("figure");
  });

  it("refuses every command on a read-only document", () => {
    const target = editorWith("<p>Kael</p>");
    target.commands.setTextSelection({ from: 1, to: 5 });
    target.setEditable(false);

    expect(toggleHeadingBlock(target)).toBe(false);
    expect(toggleTextMark(target, "strong")).toBe(false);
    expect(setToolbarAlignment(target, "center")).toBe(false);
    expect(target.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(target.state.doc.firstChild?.attrs.align).toBeNull();
  });
});

/**
 * Turn into over a swept rectangle applies per block (§10) — the same shape
 * marks already have. A CellSelection reports only its FIRST cell as
 * `from`..`to`, so the command layer walks `selection.ranges` exactly as the
 * refusal reader does; anything else converts one cell and advertises all.
 *
 * Every sweep here is a partial rectangle. A sweep covering the whole table
 * IS the selected table (an object, pinned above), so a one-row fixture would
 * test the wrong thing.
 */
describe("Turn into over a swept rectangle", () => {
  const gridCell = (block: JSONContent): JSONContent => ({
    type: "table_cell",
    content: [block],
  });
  const prose = (text: string): JSONContent =>
    gridCell({ type: "paragraph", content: [{ type: "text", text }] });

  /** Two rows by two columns, so a swept row is a rectangle, not the table. */
  function gridDoc(row1: JSONContent[], row2: JSONContent[]): JSONContent {
    return {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            { type: "table_row", content: row1 },
            { type: "table_row", content: row2 },
          ],
        },
      ],
    };
  }

  const PLAIN_GRID = gridDoc([prose("Status"), prose("Kael")], [prose("Rank"), prose("Nine")]);

  /** First block of every cell, in document order. */
  function cellBlocks(target: Editor): string[] {
    return cellPositions(target).map(
      (pos) => target.state.doc.nodeAt(pos)?.firstChild?.type.name ?? "missing",
    );
  }

  function sweepFirstRow(target: Editor): void {
    const [first, second] = cellPositions(target);
    selectCells(target, first, second);
  }

  it("keeps the sweep selected, and the second press toggles it back (law 6)", () => {
    const target = editorWith(PLAIN_GRID);
    sweepFirstRow(target);

    expect(turnIntoBlockType(target, "heading2")).toBe(true);
    // The writer swept a rectangle; the conversion must not eat the selection.
    expect(target.state.selection).toBeInstanceOf(CellSelection);

    expect(turnIntoBlockType(target, "heading2")).toBe(true);
    expect(cellBlocks(target)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph"]);
  });

  it("refuses the whole sweep when a swept cell holds a rendered fence", () => {
    const target = editorWith(
      gridDoc(
        [
          gridCell({
            type: "code_block",
            attrs: { language: "mermaid" },
            content: [{ type: "text", text: "graph TD; A --> B" }],
          }),
          prose("Kael"),
        ],
        [prose("Rank"), prose("Nine")],
      ),
    );
    const [diagramCell] = cellPositions(target);
    sweepFirstRow(target);

    // The deepest owner still answers first for what a cell HOLDS: a diagram
    // in the rectangle refuses like a diagram in a select-all.
    expect(controlsFor(target).heading.blockedBy).toBe("mixed-selection");
    expect(turnIntoBlockType(target, "heading1")).toBe(false);
    const fence = target.state.doc.nodeAt(diagramCell)?.firstChild;
    expect(fence?.type.name).toBe("code_block");
    expect(fence?.attrs.language).toBe("mermaid");
  });
});
