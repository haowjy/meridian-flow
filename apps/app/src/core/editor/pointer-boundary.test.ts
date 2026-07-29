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

type Layout = { doc: PMNode; bands: BlockBand[] };

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
  });
}

type Landing =
  | { kind: "text"; block: string; index: number }
  | { kind: "gap"; index: number }
  | { kind: "decline"; reason: string };

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
