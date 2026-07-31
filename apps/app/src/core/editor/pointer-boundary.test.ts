/**
 * The decision table for a press outside the prose.
 *
 * Each row is a place a writer can press in the editor pane's inert space, and
 * the spec is this list: what changes here changes where the caret goes. The
 * assertions are the selection TYPE and the block that owns it, never a pixel —
 * the bug that started this file was a seam press resolving to a rendered
 * diagram's hidden source, which looks like nothing at all until a keystroke
 * disappears into it.
 */
import { getSchema, type JSONContent } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "./config";
import {
  type BlockBand,
  type PointerBoundaryContainer,
  type PointerBoundaryDecision,
  resolvePointerBoundary,
} from "./pointer-boundary";

const schema = getSchema(createStandaloneEditorExtensions());

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const fence = (language: string, source: string): JSONContent => ({
  type: "code_block",
  attrs: { language },
  content: [{ type: "text", text: source }],
});

const diagram = (): JSONContent => fence("mermaid", "flowchart LR\nA --> B");

const figure = (): JSONContent => ({ type: "figure", attrs: { src: "asset:1", caption: "" } });

const cell = (text: string): JSONContent => ({
  type: "table_cell",
  content: [paragraph(text)],
});

const table = (): JSONContent => ({
  type: "table",
  content: [{ type: "table_row", content: [cell("A1"), cell("A2")] }],
});

/** A block's height and the inert strip under it, as the manuscript lays out. */
const BLOCK_HEIGHT = 100;
const SEAM_HEIGHT = 14.4;

type Layout = { doc: PMNode; bands: BlockBand[]; container?: PointerBoundaryContainer };

/** Stacks the document's top-level blocks down the page with a seam between. */
function layout(content: JSONContent[]): Layout {
  const doc = schema.nodeFromJSON({ type: "doc", content });
  const bands: BlockBand[] = [];
  let pos = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const top = index * (BLOCK_HEIGHT + SEAM_HEIGHT);
    bands.push({ pos, top, bottom: top + BLOCK_HEIGHT });
    pos += doc.child(index).nodeSize;
  }
  return { doc, bands };
}

type CellPage = Layout & { container: PointerBoundaryContainer; cellPos: number };

/**
 * The same stacked layout, one level down: the pressed cell holds `content`,
 * a neighbouring cell holds prose a scoping bug would leak into, and the
 * document keeps prose above and below the table for the same reason.
 */
function cellLayout(content: JSONContent[]): CellPage {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      paragraph("outside above"),
      {
        type: "table",
        content: [
          { type: "table_row", content: [{ type: "table_cell", content }, cell("neighbour")] },
        ],
      },
      paragraph("outside below"),
    ],
  });

  let cellPos: number | null = null;
  doc.descendants((node, pos) => {
    if (cellPos === null && node.type.name === "table_cell") cellPos = pos;
    return cellPos === null;
  });
  if (cellPos === null) throw new Error("no cell in the fixture");
  const cellNode = doc.nodeAt(cellPos);
  if (!cellNode) throw new Error("no node at the cell position");

  const bands: BlockBand[] = [];
  let pos = cellPos + 1;
  for (let index = 0; index < cellNode.childCount; index += 1) {
    const top = index * (BLOCK_HEIGHT + SEAM_HEIGHT);
    bands.push({ pos, top, bottom: top + BLOCK_HEIGHT });
    pos += cellNode.child(index).nodeSize;
  }
  return { doc, bands, container: { node: cellNode, pos: cellPos }, cellPos };
}

/** The last position inside a block: what `posAtCoords` answers at a seam. */
function endInside({ doc, bands }: Layout, index: number): number {
  const band = bands[index];
  if (!band) throw new Error(`no block ${index}`);
  const node = doc.nodeAt(band.pos);
  if (!node) throw new Error(`no node at ${band.pos}`);
  return band.pos + node.nodeSize - 1;
}

/** A press in the strip below block `index`, with the worst answer geometry gives. */
function pressInSeamAfter(page: Layout, index: number): PointerBoundaryDecision {
  const band = page.bands[index];
  if (!band) throw new Error(`no block ${index}`);
  return resolvePointerBoundary({
    doc: page.doc,
    y: band.bottom + SEAM_HEIGHT / 2,
    bands: page.bands,
    coordsPos: endInside(page, index),
    container: page.container,
  });
}

/** A press in the horizontal gutter beside block `index`. */
function pressBeside(page: Layout, index: number, coordsPos: number): PointerBoundaryDecision {
  const band = page.bands[index];
  if (!band) throw new Error(`no block ${index}`);
  return resolvePointerBoundary({
    doc: page.doc,
    y: (band.top + band.bottom) / 2,
    bands: page.bands,
    coordsPos,
    container: page.container,
  });
}

/** A press in the empty page below the last block. */
function pressBelowDocument(page: Layout): PointerBoundaryDecision {
  const last = page.bands.at(-1);
  if (!last) throw new Error("no blocks");
  return resolvePointerBoundary({
    doc: page.doc,
    y: last.bottom + 200,
    bands: page.bands,
    coordsPos: endInside(page, page.bands.length - 1),
    container: page.container,
  });
}

/** A press in the inert strip above the container's first block. */
function pressAboveFirstBlock(page: Layout): PointerBoundaryDecision {
  const first = page.bands[0];
  if (!first) throw new Error("no blocks");
  return resolvePointerBoundary({
    doc: page.doc,
    y: first.top - 4,
    bands: page.bands,
    coordsPos: endInside(page, 0),
    container: page.container,
  });
}

type Landing =
  | { kind: "text"; block: string; index: number }
  | { kind: "gap"; index: number }
  | { kind: "decline"; reason: string };

type CellLanding =
  | Landing
  /** The selection left the pressed cell — the failure the invariant forbids. */
  | { kind: "escaped"; at: number };

/**
 * The selection type and the CELL child that owns it. `escaped` is any landing
 * outside the pressed cell's interior — a neighbouring cell and the document
 * both count, because §4's hardest invariant is that neither ever answers.
 */
function cellLanding(page: CellPage, decision: PointerBoundaryDecision): CellLanding {
  if (decision.kind === "decline") return { kind: "decline", reason: decision.reason };
  const { selection } = decision;
  const start = page.cellPos + 1;
  const end = start + page.container.node.content.size;
  if (selection.from < start || selection.from > end) {
    return { kind: "escaped", at: selection.from };
  }
  const $from = page.doc.resolve(selection.from);
  const cellDepth = page.doc.resolve(start).depth;
  if (selection instanceof GapCursor) return { kind: "gap", index: $from.index(cellDepth) };
  if (!(selection instanceof TextSelection)) throw new Error("unexpected selection type");
  return {
    kind: "text",
    block: $from.node(cellDepth + 1).type.name,
    index: $from.index(cellDepth),
  };
}

/** The selection type and the top-level block that owns it. */
function landing(doc: PMNode, decision: PointerBoundaryDecision): Landing {
  if (decision.kind === "decline") return { kind: "decline", reason: decision.reason };
  const { selection } = decision;
  const $from = doc.resolve(selection.from);
  if (selection instanceof GapCursor) return { kind: "gap", index: $from.index(0) };
  if (!(selection instanceof TextSelection)) throw new Error("unexpected selection type");
  return { kind: "text", block: $from.node(1).type.name, index: $from.index(0) };
}

describe("a press in the seam between two blocks", () => {
  it("lands in the paragraph after a rendered diagram, never in its source", () => {
    // The reported bug, as a table row. Geometry answered with the fence's own
    // hidden text; the seam belongs to neither block, and prose takes it.
    const page = layout([paragraph("before"), diagram(), paragraph("after")]);

    expect(landing(page.doc, pressInSeamAfter(page, 1))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 2,
    });
  });

  it("lands in the first cell of a following table", () => {
    const page = layout([paragraph("before"), table()]);

    expect(landing(page.doc, pressInSeamAfter(page, 0))).toEqual({
      kind: "text",
      block: "table",
      index: 1,
    });
  });

  it("lands in the paragraph after a table", () => {
    const page = layout([table(), paragraph("after")]);

    expect(landing(page.doc, pressInSeamAfter(page, 0))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 1,
    });
  });

  it("stays in the paragraph above a plain fence rather than entering it", () => {
    // A seam press prefers prose to syntax: the fence did not ask for it.
    const page = layout([paragraph("before"), fence("typescript", "const a = 1;")]);

    expect(landing(page.doc, pressInSeamAfter(page, 0))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 0,
    });
  });

  it("lands in the paragraph after a plain fence", () => {
    const page = layout([fence("typescript", "const a = 1;"), paragraph("after")]);

    expect(landing(page.doc, pressInSeamAfter(page, 0))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 1,
    });
  });

  it("puts a gap cursor between two objects that hold no writer text", () => {
    const page = layout([figure(), figure()]);

    expect(landing(page.doc, pressInSeamAfter(page, 0))).toEqual({ kind: "gap", index: 1 });
  });

  it("reaches past two diagrams that cannot hold a gap cursor between them", () => {
    // A code block is a text block, so prosemirror-gapcursor refuses the
    // boundary. The press still asked for a caret, and forward is the seam's
    // own bias.
    const page = layout([paragraph("before"), diagram(), diagram(), paragraph("after")]);

    expect(landing(page.doc, pressInSeamAfter(page, 1))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 3,
    });
  });
});

describe("a press in the gutter beside a block", () => {
  it("takes the line the pointer is beside", () => {
    const page = layout([paragraph("before"), paragraph("beside")]);

    expect(landing(page.doc, pressBeside(page, 1, endInside(page, 1)))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 1,
    });
  });

  it("enters a plain fence, whose text is on the page", () => {
    const page = layout([paragraph("before"), fence("typescript", "const a = 1;")]);

    expect(landing(page.doc, pressBeside(page, 1, endInside(page, 1)))).toEqual({
      kind: "text",
      block: "code_block",
      index: 1,
    });
  });

  it("refuses a rendered diagram's hidden source and answers at its near edge", () => {
    // Upper half of the band, so the answer is the prose the diagram follows.
    const page = layout([paragraph("before"), diagram(), paragraph("after")]);
    const band = page.bands[1];
    if (!band) throw new Error("no diagram band");
    const decision = resolvePointerBoundary({
      doc: page.doc,
      y: band.top + 1,
      bands: page.bands,
      coordsPos: endInside(page, 1),
    });

    expect(landing(page.doc, decision)).toEqual({
      kind: "text",
      block: "paragraph",
      index: 0,
    });
  });
});

describe("a press in the page below the document", () => {
  it("lands at the end of the last paragraph", () => {
    const page = layout([paragraph("before"), paragraph("last")]);
    const decision = pressBelowDocument(page);

    expect(landing(page.doc, decision)).toEqual({ kind: "text", block: "paragraph", index: 1 });
    if (decision.kind !== "place") throw new Error("expected a placement");
    expect(decision.selection.from).toBe(page.doc.content.size - 1);
  });

  it("keeps the end of a trailing plain fence reachable", () => {
    const page = layout([paragraph("before"), fence("typescript", "const a = 1;")]);

    expect(landing(page.doc, pressBelowDocument(page))).toEqual({
      kind: "text",
      block: "code_block",
      index: 1,
    });
  });

  it("stops short of a trailing diagram's source and takes the prose above it", () => {
    const page = layout([paragraph("before"), diagram()]);

    expect(landing(page.doc, pressBelowDocument(page))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 0,
    });
  });

  it("declines when the document has no visible caret anywhere", () => {
    const page = layout([diagram()]);

    expect(landing(page.doc, pressBelowDocument(page))).toEqual({
      kind: "decline",
      reason: "no-writer-text",
    });
  });
});

/**
 * The same policies one level down (§4): the bands are the pressed cell's own
 * children and every answer stays inside that cell. The cell is isolating, so
 * a press inside it must never resolve to a neighbouring cell or the document
 * — every fixture keeps both within leaking distance to prove it.
 */
describe("a press inside a cell", () => {
  it("takes the line beside the pointer in the cell's own prose", () => {
    const page = cellLayout([paragraph("first"), paragraph("second")]);

    expect(cellLanding(page, pressBeside(page, 1, endInside(page, 1)))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 1,
    });
  });

  it("lands in the paragraph after a rendered diagram, never in its source", () => {
    const page = cellLayout([paragraph("lead"), diagram(), paragraph("tail")]);

    expect(cellLanding(page, pressInSeamAfter(page, 1))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 2,
    });
  });

  it("stays in the prose above a fence rather than entering it", () => {
    const page = cellLayout([paragraph("lead"), fence("typescript", "const a = 1;")]);

    expect(cellLanding(page, pressInSeamAfter(page, 0))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 0,
    });
  });

  it("lands in the paragraph after a diagram that opens the cell", () => {
    const page = cellLayout([diagram(), paragraph("tail")]);

    expect(cellLanding(page, pressAboveFirstBlock(page))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 1,
    });
  });

  it("puts a gap cursor between two figures in the cell", () => {
    const page = cellLayout([figure(), figure()]);

    expect(cellLanding(page, pressInSeamAfter(page, 0))).toEqual({ kind: "gap", index: 1 });
  });

  it("returns to the cell's own prose past trailing diagrams, never a neighbour's", () => {
    // Forward exhausts inside the cell, and the neighbouring cell's prose is
    // NOT the next answer: the fall-back walks back to the cell's own text.
    const page = cellLayout([paragraph("lead"), diagram(), diagram()]);

    expect(cellLanding(page, pressInSeamAfter(page, 1))).toEqual({
      kind: "text",
      block: "paragraph",
      index: 0,
    });
  });

  it("stays in the cell when the press falls past its last block", () => {
    // An opaque object ends the cell, so the nearest caret forward of the
    // press is the neighbouring cell's text — which must not answer. The gap
    // cursor at the cell's own end is the landing.
    const page = cellLayout([paragraph("lead"), figure()]);

    expect(cellLanding(page, pressBelowDocument(page))).toEqual({ kind: "gap", index: 2 });
  });

  it("declines in a cell whose only child is a rendered diagram", () => {
    // No gap cursor fits beside a fence (its schema still holds typeable
    // text), and the cell offers no prose: declining beats answering with the
    // neighbour's text or the document's.
    const page = cellLayout([diagram()]);

    expect(cellLanding(page, pressBelowDocument(page))).toEqual({
      kind: "decline",
      reason: "no-writer-text",
    });
  });
});
