// @vitest-environment jsdom
import type { Editor, JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditor, type StandaloneEditor } from "@/test-support/standalone-editor";
import type { SlashCommandCatalog, SlashCommandId, SlashCommandItem } from "./slash-catalog";
import { applySlashCommand } from "./slash-insertion";

let fixture: StandaloneEditor | null = null;

afterEach(() => {
  fixture?.destroy();
  fixture = null;
});

const catalog = (requestImageUpload = vi.fn()): SlashCommandCatalog => ({
  items: [],
  menuLabel: "Insert",
  groupLabels: { text: "Text", insert: "Insert" },
  requestImageUpload,
});

function item(id: SlashCommandId): SlashCommandItem {
  return { id, group: "text", label: id, aliases: [] };
}

const TRIGGER = "/x";

function mountAround(content: JSONContent[]) {
  fixture = createStandaloneEditor({
    content: { type: "doc", content },
  });
  const { editor } = fixture;
  let from: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (from !== null) return false;
    if (!node.isText) return true;
    const index = node.text?.indexOf(TRIGGER) ?? -1;
    if (index >= 0) from = pos + index;
    return true;
  });
  if (from === null) throw new Error("fixture has no trigger");
  return { editor, range: { from, to: from + TRIGGER.length } };
}

const listItem = (text: string): JSONContent => ({
  type: "paragraph",
  attrs: { path: "-", marker: "item" },
  content: text ? [{ type: "text", text }] : [],
});

const cell = (text: string): JSONContent => ({
  type: "table_cell",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
});

const row = (...cells: JSONContent[]): JSONContent => ({ type: "table_row", content: cells });

function cellAroundCaret(instance: Editor): unknown {
  return instance.state.selection.$from.node(-1).type.spec.tableRole;
}

function blockTypes(instance: Editor): string[] {
  return instance.state.doc.content.content.map((node) => node.type.name);
}

describe("slash insertion out of nested structures", () => {
  it("keeps a multi-item list whole and lands after it", () => {
    const { editor: instance, range } = mountAround([
      listItem("first"),
      listItem(`second ${TRIGGER}`),
      listItem("third"),
    ]);
    applySlashCommand(instance, range, item("table"), catalog());

    expect(blockTypes(instance)).toEqual(["paragraph", "paragraph", "paragraph", "table"]);
    expect(instance.state.doc.child(0).textContent).toBe("first");
    expect(instance.state.doc.child(1).textContent).toBe("second ");
    expect(instance.state.doc.child(2).textContent).toBe("third");
  });

  it("asks the host for a picture at the place the trigger left, inside the cell", () => {
    const requestImageUpload = vi.fn();
    const { editor: instance, range } = mountAround([
      { type: "table", content: [row(cell(`portrait ${TRIGGER}`), cell("notes"))] },
    ]);

    const applied = applySlashCommand(instance, range, item("image"), catalog(requestImageUpload));

    expect(applied).toBe(true);
    expect(blockTypes(instance)).toEqual(["table"]);
    expect(instance.state.doc.textContent).toBe("portrait notes");
    expect(requestImageUpload).toHaveBeenCalledTimes(1);
    const [anchor] = requestImageUpload.mock.calls[0];
    expect(anchor).toMatchObject({ from: range.from, to: range.from });
    expect(instance.state.doc.resolve(anchor.from).node(-1).type.spec.tableRole).toBe("cell");
    expect(cellAroundCaret(instance)).toBe("cell");
  });
});
