// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { proseSelectionCovers } from "./chrome-context";

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

function positionOf(instance: Editor, type: string): number {
  let found: number | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === type) found = pos;
    return found === null;
  });
  if (found === null) throw new Error(`no ${type} in the fixture`);
  return found;
}

describe("what counts as a prose selection the pointer is inside", () => {
  it("is true for swept text under the pointer", () => {
    const instance = mount([paragraph("The third gate opened.")]);
    instance.view.dispatch(
      instance.state.tr.setSelection(TextSelection.create(instance.state.doc, 1, 10)),
    );

    expect(proseSelectionCovers(instance.state, 5)).toBe(true);
  });

  it("is false where the pointer sits outside the swept range", () => {
    const instance = mount([paragraph("The third gate opened.")]);
    instance.view.dispatch(
      instance.state.tr.setSelection(TextSelection.create(instance.state.doc, 1, 10)),
    );

    expect(proseSelectionCovers(instance.state, 18)).toBe(false);
  });

  it("is false for a bare caret: there is nothing to format", () => {
    const instance = mount([paragraph("The third gate opened.")]);
    instance.view.dispatch(
      instance.state.tr.setSelection(TextSelection.create(instance.state.doc, 5)),
    );

    expect(proseSelectionCovers(instance.state, 5)).toBe(false);
  });

  it("is false for a selected object, however wide its range", () => {
    const instance = mount([paragraph("before"), { type: "horizontal_rule" }]);
    const pos = positionOf(instance, "horizontal_rule");
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, pos)),
    );

    expect(proseSelectionCovers(instance.state, pos)).toBe(false);
  });

  it("is false for a whole-table cell selection: no prose text is selected", () => {
    const instance = mount([
      {
        type: "table",
        content: [{ type: "table_row", content: [cell("Rank"), cell("Skill")] }],
      },
    ]);
    const tablePos = positionOf(instance, "table");
    const map = instance.state.doc.nodeAt(tablePos);
    if (!map) throw new Error("no table");

    const firstCell = instance.state.doc.resolve(positionOf(instance, "table_cell"));
    const lastCell = instance.state.doc.resolve(
      positionOf(instance, "table_cell") + firstCell.nodeAfter!.nodeSize,
    );
    instance.view.dispatch(instance.state.tr.setSelection(new CellSelection(firstCell, lastCell)));

    expect(instance.state.selection).toBeInstanceOf(CellSelection);
    expect(instance.state.selection.empty).toBe(false);
    // The design ranks a prose selection above an object claim (§5.1). A cell
    // selection that answered "yes" here would put the formatting menu over
    // every table right-click.
    expect(proseSelectionCovers(instance.state, instance.state.selection.from + 1)).toBe(false);
  });

  it("is true for select-all, which is how a writer formats a whole chapter", () => {
    const instance = mount([paragraph("first"), paragraph("second")]);
    instance.view.dispatch(instance.state.tr.setSelection(new AllSelection(instance.state.doc)));

    expect(proseSelectionCovers(instance.state, 3)).toBe(true);
  });
});
