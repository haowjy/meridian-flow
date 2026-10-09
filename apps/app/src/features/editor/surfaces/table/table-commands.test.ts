// @vitest-environment jsdom
/**
 * The verb matrix is the contract law 5 rests on: every refusal has a named
 * reason, and no verb advertises what dispatch would refuse. These cases walk
 * the table states a writer actually reaches — header on and off, a merged
 * cell, the edges — and assert the reason, not just the refusal.
 */
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { Editor, type JSONContent } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { runTableVerb } from "./table-commands";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent =>
  text === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text }] };

function cell(type: "table_header" | "table_cell", text: string): JSONContent {
  return { type, attrs: {}, content: [paragraph(text)] };
}

/** Header H1 H2 over body rows A and B: the shape every case starts from. */
function mount(
  rows: string[][] = [
    ["A1", "A2"],
    ["B1", "B2"],
  ],
) {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "table_row",
              content: [cell("table_header", "H1"), cell("table_header", "H2")],
            },
            ...rows.map((texts) => ({
              type: "table_row",
              content: texts.map((text) => cell("table_cell", text)),
            })),
          ],
        },
        paragraph("after"),
      ],
    },
  });
  return editor;
}

function cellPosition(current: Editor, text: string) {
  let position = -1;
  current.state.doc.descendants((node, pos) => {
    if (
      (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") &&
      node.textContent === text
    ) {
      position = pos;
    }
  });
  expect(position).toBeGreaterThanOrEqual(0);
  return position;
}

function caretIn(current: Editor, text: string) {
  current.commands.setTextSelection(cellPosition(current, text) + 2);
}

function selectCells(current: Editor, anchor: string | number, head: string | number) {
  const at = (cell: string | number) =>
    typeof cell === "number" ? cell : cellPosition(current, cell);
  current.view.dispatch(
    current.state.tr.setSelection(CellSelection.create(current.state.doc, at(anchor), at(head))),
  );
}

/** The position before the cell at a grid coordinate, spans aside. */
function cellPositionAt(current: Editor, row: number, column: number) {
  const table = tableNode(current);
  let pos = 1;
  for (let index = 0; index < row; index += 1) pos += table.child(index).nodeSize;
  pos += 1;
  const rowNode = table.child(row);
  for (let index = 0; index < column; index += 1) pos += rowNode.child(index).nodeSize;
  return pos;
}

function tableNode(current: Editor) {
  const table = current.state.doc.firstChild;
  if (!table) throw new Error("table is missing");
  return table;
}

function rowText(current: Editor): string[][] {
  const table = current.state.doc.firstChild;
  if (!table) return [];
  return Array.from({ length: table.childCount }, (_, row) =>
    Array.from(
      { length: table.child(row).childCount },
      (_, column) => table.child(row).child(column).textContent,
    ),
  );
}

const heading = (text: string): JSONContent => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
});

const bullets = (...items: string[]): JSONContent => ({
  type: "bullet_list",
  content: items.map((text) => ({ type: "list_item", content: [paragraph(text)] })),
});

/** One body row of two block-capable cells under the standard header. */
function mountCellBlocks(left: JSONContent[], right: JSONContent[]) {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "table_row",
              content: [cell("table_header", "H1"), cell("table_header", "H2")],
            },
            {
              type: "table_row",
              content: [
                { type: "table_cell", attrs: {}, content: left },
                { type: "table_cell", attrs: {}, content: right },
              ],
            },
          ],
        },
        paragraph("after"),
      ],
    },
  });
  return editor;
}

/** The merged body cell's blocks as `[type, text]` pairs, in reading order. */
function mergedCellBlocks(current: Editor): [string, string][] {
  const merged = tableNode(current).child(1).child(0);
  const blocks: [string, string][] = [];
  merged.content.forEach((block) => {
    blocks.push([block.type.name, block.textContent]);
  });
  return blocks;
}

/** The document survives the wire: serialize, reparse, same blocks. */
function expectWireFixpoint(current: Editor) {
  const codec = mdxCodec({
    schema: current.schema,
    components: {},
  });
  const blocks = [...current.state.doc.content.content];
  const reparsed = codec.parse(codec.serialize(blocks, UNSCOPED_DOCUMENT_LINKS)).blocks;
  expect(reparsed.map((block) => block.toJSON())).toEqual(blocks.map((block) => block.toJSON()));
}

describe("merge and split", () => {
  it("keeps a hard break and an inline image, which carry no text at all", () => {
    const current = mount();
    // A cell whose only content is a hard break reads as empty to
    // `textContent` and as FILLED to prosemirror-tables: its paragraph merges
    // in whole rather than being skipped as an empty cell.
    const breakCell = cellPositionAt(current, 1, 1);
    current.view.dispatch(
      current.state.tr.replaceWith(
        breakCell + 2,
        breakCell + 2 + 2,
        current.state.schema.nodes.hard_break.create(),
      ),
    );
    selectCells(current, "A1", cellPositionAt(current, 1, 1));
    expect(runTableVerb(current, "mergeCells")).toBe(true);

    const merged = tableNode(current).child(1).child(0);
    expect(merged.attrs.colspan).toBe(2);
    // The break's paragraph lands whole after "A1".
    expect(merged.child(0).textContent).toBe("A1");
    expect(merged.child(1).lastChild?.type.name).toBe("hard_break");
    // Nothing was pushed out of the table on the way.
    expect(current.state.doc.childCount).toBe(2);
  });
});

describe("merging block-capable cells", () => {
  /** Merge the two body cells, then assert the document is legal and survives the wire. */
  function mergeBodyRow(current: Editor) {
    current.view.dispatch(
      current.state.tr.setSelection(
        CellSelection.create(
          current.state.doc,
          cellPositionAt(current, 1, 0),
          cellPositionAt(current, 1, 1),
        ),
      ),
    );
    expect(runTableVerb(current, "mergeCells")).toBe(true);
    expect(() => current.state.doc.check()).not.toThrow();
    expectWireFixpoint(current);
  }

  it("appends a heading after a list rather than flattening either", () => {
    const current = mountCellBlocks(
      [bullets("gather the disciples", "seal the gate")],
      [heading("The gate")],
    );
    mergeBodyRow(current);

    expect(mergedCellBlocks(current)).toEqual([
      ["bullet_list", "gather the disciplesseal the gate"],
      ["heading", "The gate"],
    ]);
  });
});

describe("moves the writer can reach", () => {
  it("moves a row and a column and leaves the caret on what moved", () => {
    const current = mount();
    caretIn(current, "B1");
    expect(runTableVerb(current, "moveRowUp")).toBe(true);
    expect(rowText(current)).toEqual([
      ["H1", "H2"],
      ["B1", "B2"],
      ["A1", "A2"],
    ]);

    caretIn(current, "B2");
    expect(runTableVerb(current, "moveColumnLeft")).toBe(true);
    expect(rowText(current)[0]).toEqual(["H2", "H1"]);
  });
});
