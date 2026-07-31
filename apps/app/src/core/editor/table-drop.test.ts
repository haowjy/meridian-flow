// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { dropPoint } from "@tiptap/pm/transform";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "./config";
import {
  type CellBand,
  resolveTableDrop,
  seamDropTransaction,
  seamHostableSlice,
} from "./table-drop";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});

function cell(type: "table_header" | "table_cell", text: string): JSONContent {
  return { type, content: [paragraph(text)] };
}

/** 3x3 table with an image in the middle cell — the shape of the field report. */
function tableDoc(): JSONContent {
  return {
    type: "doc",
    content: [
      paragraph("Before the table."),
      {
        type: "table",
        content: [
          {
            type: "table_row",
            content: [
              cell("table_header", "H1"),
              cell("table_header", "H2"),
              cell("table_header", "H3"),
            ],
          },
          {
            type: "table_row",
            content: [
              cell("table_cell", "A1"),
              {
                type: "table_cell",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "image", attrs: { src: "asset:img-1", alt: "held" } }],
                  },
                ],
              },
              cell("table_cell", "A3"),
            ],
          },
          {
            type: "table_row",
            content: [cell("table_cell", "B1"), cell("table_cell", "B2"), cell("table_cell", "B3")],
          },
        ],
      },
      paragraph("After the table."),
    ],
  };
}

function createTableEditor(): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content: tableDoc() });
  return editor;
}

type DocShape = {
  tablePos: number;
  /** Position of every cell, in document order, grouped by grid row. */
  cellPositions: number[][];
  imagePos: number;
};

function docShape(current: Editor): DocShape {
  let tablePos = -1;
  let imagePos = -1;
  const cellPositions: number[][] = [];
  current.state.doc.descendants((node, pos) => {
    if (node.type.name === "table") {
      tablePos = pos;
      node.forEach((row, rowOffset) => {
        const rowPositions: number[] = [];
        const rowStart = pos + 1 + rowOffset + 1;
        row.forEach((_cellNode, cellOffset) => {
          rowPositions.push(rowStart + cellOffset);
        });
        cellPositions.push(rowPositions);
      });
    }
    if (node.type.name === "image") imagePos = pos;
    return true;
  });
  return { tablePos, cellPositions, imagePos };
}

/** Synthetic geometry: column i spans x [i*100, (i+1)*100], row j spans y [j*30, (j+1)*30]. */
function syntheticBands(shape: DocShape): CellBand[] {
  const bands: CellBand[] = [];
  shape.cellPositions.forEach((row, rowIndex) => {
    row.forEach((pos, columnIndex) => {
      bands.push({
        pos,
        left: columnIndex * 100,
        right: (columnIndex + 1) * 100,
        top: rowIndex * 30,
        bottom: (rowIndex + 1) * 30,
      });
    });
  });
  return bands;
}

function columnCounts(current: Editor): number[] {
  const counts: number[] = [];
  current.state.doc.descendants((node) => {
    if (node.type.name !== "table") return true;
    node.forEach((row) => {
      counts.push(row.childCount);
    });
    return false;
  });
  return counts;
}

function expectOnlyTableStructure(current: Editor): void {
  current.state.doc.descendants((node) => {
    if (node.type.name === "table") {
      node.forEach((child) => {
        expect(child.type.name).toBe("table_row");
      });
    }
    if (node.type.name === "table_row") {
      node.forEach((child) => {
        expect(child.type.spec.tableRole).toMatch(/^(?:cell|header_cell)$/);
      });
    }
    return true;
  });
}

function imageSlice(current: Editor, imagePos: number): Slice {
  const image = current.state.doc.nodeAt(imagePos);
  if (!image) throw new Error("no image at position");
  return new Slice(Fragment.from(image), 0, 0);
}

describe("resolveTableDrop", () => {
  it("answers default for an inline position inside a cell", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    // Inside A1's paragraph text.
    const inA1 = shape.cellPositions[1][0] + 2;
    const decision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: inA1,
      x: 50,
      y: 45,
      cells: syntheticBands(shape),
    });
    expect(decision).toEqual({ kind: "default" });
  });

  it("answers default for prose outside the table", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    const decision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: 3,
      x: 10,
      y: 10,
      cells: syntheticBands(shape),
    });
    expect(decision).toEqual({ kind: "default" });
  });

  it("snaps a cell-boundary position into that cell's paragraph", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    // Just inside B2, before its paragraph: the exact resolution the live
    // repro produced (parent table_cell, offset 0). Under block+ PM's own
    // dropPoint keeps this payload inside the cell too.
    const cellPos = shape.cellPositions[2][1];
    const rawPos = cellPos + 1;
    const $raw = current.state.doc.resolve(rawPos);
    expect($raw.parent.type.name).toBe("table_cell");
    const slice = imageSlice(current, shape.imagePos);
    const pmAnswer = dropPoint(current.state.doc, rawPos, slice);
    expect(pmAnswer).not.toBeNull();
    if (pmAnswer === null) throw new Error("unreachable");
    expect(current.state.doc.resolve(pmAnswer).parent.type.name).toBe("table_cell");

    // Pointer sits on the border between B1 and B2 (x = 100), row 2 (y = 75).
    const decision = resolveTableDrop({
      doc: current.state.doc,
      rawPos,
      x: 101,
      y: 75,
      cells: syntheticBands(shape),
    });
    expect(decision.kind).toBe("snap");
    if (decision.kind !== "snap") throw new Error("unreachable");
    const $snap = current.state.doc.resolve(decision.pos);
    expect($snap.parent.isTextblock).toBe(true);
    expect($snap.node(-1).type.name).toMatch(/table_cell|table_header/);
  });

  it("snaps a between-cells seam toward the cell under the pointer", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    // Row-child seam between B1 and B2 (parent table_row).
    const seamPos = shape.cellPositions[2][1];
    const rawAtSeam = current.state.doc.resolve(seamPos);
    expect(rawAtSeam.parent.type.name).toBe("table_row");

    // Pointer just left of the border: inside B1's band.
    const leftDecision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: seamPos,
      x: 98,
      y: 75,
      cells: syntheticBands(shape),
    });
    expect(leftDecision.kind).toBe("snap");
    if (leftDecision.kind !== "snap") throw new Error("unreachable");
    const $left = current.state.doc.resolve(leftDecision.pos);
    expect($left.node(-1)).toBe(current.state.doc.nodeAt(shape.cellPositions[2][0]));

    // Pointer just right of the border: inside B2's band.
    const rightDecision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: seamPos,
      x: 102,
      y: 75,
      cells: syntheticBands(shape),
    });
    expect(rightDecision.kind).toBe("snap");
    if (rightDecision.kind !== "snap") throw new Error("unreachable");
    const $right = current.state.doc.resolve(rightDecision.pos);
    expect($right.node(-1)).toBe(current.state.doc.nodeAt(shape.cellPositions[2][1]));
  });

  it("snaps a between-rows seam into the nearest cell", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    // Table-child seam between row 0 and row 1.
    const seamPos = shape.cellPositions[1][0] - 1;
    const $seam = current.state.doc.resolve(seamPos);
    expect($seam.parent.type.name).toBe("table");

    // Pointer under column 3, on the border between rows 0 and 1.
    const decision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: seamPos,
      x: 250,
      y: 31,
      cells: syntheticBands(shape),
    });
    expect(decision.kind).toBe("snap");
    if (decision.kind !== "snap") throw new Error("unreachable");
    const $snap = current.state.doc.resolve(decision.pos);
    expect($snap.parent.isTextblock).toBe(true);
    // Landed in column 3 of one of the bordering rows.
    const target = $snap.node(-1);
    const candidates = [
      current.state.doc.nodeAt(shape.cellPositions[0][2]),
      current.state.doc.nodeAt(shape.cellPositions[1][2]),
    ];
    expect(candidates).toContain(target);
  });

  it("refuses when the table has no cell to stand in", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    const cellPos = shape.cellPositions[2][1];
    const decision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: cellPos + 1,
      x: 101,
      y: 75,
      cells: [],
    });
    expect(decision).toEqual({ kind: "refuse" });
  });
});

describe("seamDropTransaction", () => {
  it("keeps the column count invariant when an image drops at a cell boundary", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    expect(columnCounts(current)).toEqual([3, 3, 3]);

    const slice = imageSlice(current, shape.imagePos);
    const decision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: shape.cellPositions[2][1] + 1,
      x: 101,
      y: 75,
      cells: syntheticBands(shape),
    });
    if (decision.kind !== "snap") throw new Error("expected snap");

    const transaction = seamDropTransaction(current.state, decision.pos, slice, {
      moved: true,
      node: null,
    });
    expect(transaction).not.toBeNull();
    if (!transaction) throw new Error("unreachable");
    current.view.dispatch(transaction);
    expect(columnCounts(current)).toEqual([3, 3, 3]);
    expectOnlyTableStructure(current);

    // The image stands in the target cell's paragraph now.
    const after = docShape(current);
    const targetCell = current.state.doc.nodeAt(after.cellPositions[2][1]);
    let found = false;
    targetCell?.descendants((node) => {
      if (node.type.name === "image") found = true;
      return true;
    });
    expect(found).toBe(true);
  });

  it("moves rather than copies: one image before, one image after", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    const slice = imageSlice(current, shape.imagePos);
    // The drag's own source selection, as PM would carry it.
    current.commands.setNodeSelection(shape.imagePos);
    const decision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: shape.cellPositions[2][2] + 1,
      x: 299,
      y: 75,
      cells: syntheticBands(shape),
    });
    if (decision.kind !== "snap") throw new Error("expected snap");
    const transaction = seamDropTransaction(current.state, decision.pos, slice, {
      moved: true,
      node: current.state.selection,
    });
    if (!transaction) throw new Error("expected a transaction");
    current.view.dispatch(transaction);

    let images = 0;
    current.state.doc.descendants((node) => {
      if (node.type.name === "image") images += 1;
      return true;
    });
    expect(images).toBe(1);
    expect(columnCounts(current)).toEqual([3, 3, 3]);
  });

  it("lands a two-paragraph drag inside the target cell", () => {
    // §3b: cells hold any block sequence, so a multi-block slice has an
    // honest seam landing — inside the pressed cell, with the grid untouched.
    const current = createTableEditor();
    const shape = docShape(current);
    const two = Fragment.fromArray([
      current.state.schema.nodes.paragraph.create(null, current.state.schema.text("one")),
      current.state.schema.nodes.paragraph.create(null, current.state.schema.text("two")),
    ]);
    const decision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: shape.cellPositions[2][1] + 1,
      x: 101,
      y: 75,
      cells: syntheticBands(shape),
    });
    if (decision.kind !== "snap") throw new Error("expected snap");
    const transaction = seamDropTransaction(current.state, decision.pos, new Slice(two, 1, 1), {
      moved: false,
      node: null,
    });
    expect(transaction).not.toBeNull();
    if (!transaction) throw new Error("unreachable");
    current.view.dispatch(transaction);

    expect(columnCounts(current)).toEqual([3, 3, 3]);
    expectOnlyTableStructure(current);
    const targetCell = current.state.doc.nodeAt(docShape(current).cellPositions[2][1]);
    expect(targetCell?.textContent).toContain("one");
    expect(targetCell?.textContent).toContain("two");
  });

  it("lands a list followed by a paragraph inside the target cell", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    const { schema } = current.state;
    const listAndParagraph = Fragment.fromArray([
      schema.nodes.bullet_list.create(null, [
        schema.nodes.list_item.create(
          null,
          schema.nodes.paragraph.create(null, schema.text("item")),
        ),
      ]),
      schema.nodes.paragraph.create(null, schema.text("tail")),
    ]);
    const decision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: shape.cellPositions[2][1] + 1,
      x: 101,
      y: 75,
      cells: syntheticBands(shape),
    });
    if (decision.kind !== "snap") throw new Error("expected snap");
    const transaction = seamDropTransaction(
      current.state,
      decision.pos,
      new Slice(listAndParagraph, 0, 0),
      { moved: false, node: null },
    );
    expect(transaction).not.toBeNull();
    if (!transaction) throw new Error("unreachable");
    current.view.dispatch(transaction);

    expect(columnCounts(current)).toEqual([3, 3, 3]);
    expectOnlyTableStructure(current);
    const targetCell = current.state.doc.nodeAt(docShape(current).cellPositions[2][1]);
    let hasList = false;
    targetCell?.descendants((node) => {
      if (node.type.name === "bullet_list") hasList = true;
      return true;
    });
    expect(hasList).toBe(true);
    expect(targetCell?.textContent).toContain("tail");
  });

  it("keeps the grid when the slice is table structure itself", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    const cellNode = current.state.doc.nodeAt(shape.cellPositions[2][0]);
    if (!cellNode) throw new Error("no cell in the fixture");
    const cellSlice = new Slice(Fragment.from(cellNode), 0, 0);
    const decision = resolveTableDrop({
      doc: current.state.doc,
      rawPos: shape.cellPositions[2][1] + 1,
      x: 101,
      y: 75,
      cells: syntheticBands(shape),
    });
    if (decision.kind !== "snap") throw new Error("expected snap");
    const transaction = seamDropTransaction(current.state, decision.pos, cellSlice, {
      moved: false,
      node: null,
    });
    // Either the fitter found a shape-preserving landing or the drop refused —
    // both keep the grid; a fourth column is the one forbidden outcome.
    if (transaction) current.view.dispatch(transaction);
    expect(columnCounts(current)).toEqual([3, 3, 3]);
    expectOnlyTableStructure(current);
  });
});

describe("seamHostableSlice", () => {
  /** An inline position inside B2's paragraph — a seam snap's landing. */
  function seamPos(current: Editor): number {
    return docShape(current).cellPositions[2][1] + 2;
  }

  it("hosts a dragged inline image", () => {
    const current = createTableEditor();
    const shape = docShape(current);
    expect(
      seamHostableSlice(current.state, seamPos(current), imageSlice(current, shape.imagePos)),
    ).toBe(true);
  });

  it("hosts a plain text drag", () => {
    const current = createTableEditor();
    const p = current.state.schema.nodes.paragraph.create(null, current.state.schema.text("word"));
    expect(
      seamHostableSlice(current.state, seamPos(current), new Slice(Fragment.from(p), 1, 1)),
    ).toBe(true);
  });

  it("hosts a file drop, which carries no slice", () => {
    const current = createTableEditor();
    expect(seamHostableSlice(current.state, seamPos(current), null)).toBe(true);
  });

  it("hosts a multi-paragraph drag", () => {
    // The deleted one-paragraph floor's last stand: cells hold any block
    // sequence now, and hostability is the actual schema fit, not a count.
    const current = createTableEditor();
    const two = Fragment.fromArray([
      current.state.schema.nodes.paragraph.create(null, current.state.schema.text("one")),
      current.state.schema.nodes.paragraph.create(null, current.state.schema.text("two")),
    ]);
    expect(seamHostableSlice(current.state, seamPos(current), new Slice(two, 1, 1))).toBe(true);
  });

  it("hosts a list followed by a paragraph", () => {
    const current = createTableEditor();
    const { schema } = current.state;
    const listAndParagraph = Fragment.fromArray([
      schema.nodes.bullet_list.create(null, [
        schema.nodes.list_item.create(
          null,
          schema.nodes.paragraph.create(null, schema.text("item")),
        ),
      ]),
      schema.nodes.paragraph.create(null, schema.text("tail")),
    ]);
    expect(
      seamHostableSlice(current.state, seamPos(current), new Slice(listAndParagraph, 0, 0)),
    ).toBe(true);
  });
});
