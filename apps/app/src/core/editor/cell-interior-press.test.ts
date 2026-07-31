// @vitest-environment jsdom
/**
 * The router's claim, at the DOM ladder it actually rides.
 *
 * The S6 probe's repro: a press on a code-fence cell's padding reached the
 * `<td>` itself, and the browser's caret hunt crossed the border into the
 * neighbouring cell. These tests dispatch real mousedown events into the
 * mounted view and assert the two halves of the router's contract — an inert
 * press on the cell's own surface is claimed and answered inside THAT cell,
 * and a press on writer text keeps its native owner.
 *
 * jsdom has no layout, so `posAtCoords` is pinned to the geometry-less answer
 * (null) it would give here anyway; the claim, the ladder position, and the
 * cell-scoped landing are what these tests exercise — the geometry-fed policy
 * rows live in `pointer-boundary.test.ts`.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "./config";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const fence = (): JSONContent => ({
  type: "code_block",
  attrs: { language: "typescript" },
  content: [{ type: "text", text: "const a = 1;" }],
});

/** A fence-only cell beside a prose cell — the probe's exact neighbourhood. */
function fenceCellDoc(): JSONContent {
  return {
    type: "doc",
    content: [
      paragraph("before"),
      {
        type: "table",
        content: [
          {
            type: "table_row",
            content: [
              { type: "table_cell", content: [fence()] },
              { type: "table_cell", content: [paragraph("neighbour")] },
            ],
          },
        ],
      },
      paragraph("after"),
    ],
  };
}

function createCellEditor(): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content: fenceCellDoc() });
  // No layout in jsdom: the view's own answer would depend on APIs jsdom does
  // not implement. Null is what a geometry-less press reports.
  editor.view.posAtCoords = () => null;
  return editor;
}

/** Document range of the `index`th cell's interior, in document order. */
function cellRange(current: Editor, index: number): { start: number; end: number } {
  const found: { start: number; end: number }[] = [];
  current.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === "cell") {
      found.push({ start: pos + 1, end: pos + 1 + node.content.size });
    }
    return true;
  });
  const range = found[index];
  if (!range) throw new Error(`no cell ${index}`);
  return range;
}

function press(target: Element): MouseEvent {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 5,
    clientY: 5,
  });
  target.dispatchEvent(event);
  return event;
}

describe("a press on a cell's inert interior", () => {
  it("claims the cell's own surface and lands the caret inside that cell", () => {
    const current = createCellEditor();
    const fenceCell = cellRange(current, 0);
    const neighbour = cellRange(current, 1);
    // The caret starts in the NEIGHBOUR, as the probe's repro had it.
    current.commands.setTextSelection(neighbour.start + 1);

    const cellDom = current.view.dom.querySelector("td");
    if (!cellDom) throw new Error("no cell in the view");
    const event = press(cellDom);

    expect(event.defaultPrevented).toBe(true);
    const { from } = current.state.selection;
    expect(from).toBeGreaterThanOrEqual(fenceCell.start);
    expect(from).toBeLessThanOrEqual(fenceCell.end);
  });

  it("leaves a press on the neighbouring cell's text native", () => {
    const current = createCellEditor();
    const neighbour = cellRange(current, 1);
    current.commands.setTextSelection(neighbour.start + 1);
    const before = current.state.selection.from;

    const textDom = current.view.dom.querySelectorAll("td")[1]?.querySelector("p");
    if (!textDom) throw new Error("no prose in the neighbour cell");
    const event = press(textDom);

    // Unclaimed: ProseMirror and the browser own text presses, and with no
    // layout underneath, "native" means the selection stands untouched.
    expect(event.defaultPrevented).toBe(false);
    expect(current.state.selection.from).toBe(before);
  });
});
