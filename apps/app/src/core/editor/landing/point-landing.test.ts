// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";

import { createStandaloneEditor, type StandaloneEditor } from "@/test-support/standalone-editor";

import { type Geometry, landingAt } from "./point-landing";

let fixture: StandaloneEditor | null = null;

afterEach(() => {
  fixture?.destroy();
  fixture = null;
});

const cell = (text: string): JSONContent => ({
  type: "table_cell",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

// A one-row table of three 150px cells in a 200px-wide pane: only the first
// cell and part of the second are visible. Each cell has 10px of padding
// around its paragraph.
it("lands a point in the cell it is over, and clamps one beside a scrolled table to the visible cells", () => {
  fixture = createStandaloneEditor({
    content: {
      type: "doc",
      content: [
        {
          type: "table",
          content: [{ type: "table_row", content: [cell("a"), cell("b"), cell("c")] }],
        },
      ],
    },
  });
  const { state } = fixture.editor;
  const { doc } = state;

  const rects = new Map<number, { left: number; right: number; top: number; bottom: number }>();
  const cells: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "table") rects.set(pos, { left: 0, right: 200, top: 0, bottom: 40 });
    if (node.type.name === "table_cell") {
      const left = cells.length * 150;
      cells.push(pos);
      rects.set(pos, { left, right: left + 150, top: 0, bottom: 40 });
    }
    if (node.type.name === "paragraph") {
      const left = (cells.length - 1) * 150;
      rects.set(pos, { left: left + 10, right: left + 140, top: 10, bottom: 30 });
    }
  });
  const geometry: Geometry = {
    rectOf: (pos) => rects.get(pos) ?? { left: 0, right: 0, top: 0, bottom: 0 },
    focused: () => true,
    inlineAt: () => null,
  };
  const cellOf = (x: number, y: number) => {
    const landing = landingAt(state, { x, y }, geometry);
    return {
      kind: landing.kind,
      cell: cells.filter((start) => landing.pos > start).length - 1,
    };
  };

  expect([
    cellOf(20, 20), // over the first cell's text
    cellOf(175, 20), // over the second cell's text
    cellOf(155, 3), // in the second cell's padding
    cellOf(500, 20), // beside the table, past a cell scrolled out of view
  ]).toEqual([
    { kind: "inline", cell: 0 },
    { kind: "inline", cell: 1 },
    { kind: "inline", cell: 1 },
    { kind: "inline", cell: 1 },
  ]);
});
