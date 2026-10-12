// @vitest-environment jsdom
/**
 * The semantics matrix: what each entry leaves in the document, and where the
 * caret is standing afterwards.
 *
 * Both halves of §5.7 are contracts a writer feels immediately — an entry that
 * restyles the sentence they were writing, or one that lands the caret outside
 * the thing they just asked for, is the F4/law 2 failure the rebuild exists to
 * fix — and neither is visible from the trigger's own tests.
 */
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

/**
 * Mounts arbitrary structure and finds the `/x` a writer typed inside it, so a
 * nested case reads as the document it is rather than as position arithmetic.
 */
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
  type: "list_item",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
});

const cell = (text: string): JSONContent => ({
  type: "table_cell",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
});

const row = (...cells: JSONContent[]): JSONContent => ({ type: "table_row", content: cells });

/** The table role of the node holding the caret's paragraph, so "still in the cell" reads as itself. */
function cellAroundCaret(instance: Editor): unknown {
  return instance.state.selection.$from.node(-1).type.spec.tableRole;
}

function blockTypes(instance: Editor): string[] {
  return instance.state.doc.content.content.map((node) => node.type.name);
}

/**
 * §5.7 says the new block lands "after the current one", and inside a list or
 * a table that sentence needs a level. A list item exists only as part of its
 * list and a cell only as part of its table, so "after" means after the whole
 * structure: a table wedged inside a bullet, or a command that silently does
 * nothing because the cell will not take it (law 5), is not what the writer
 * asked for.
 */
describe("slash insertion out of nested structures", () => {
  it("keeps a multi-item list whole and lands after it", () => {
    const { editor: instance, range } = mountAround([
      {
        type: "bullet_list",
        content: [listItem("first"), listItem(`second ${TRIGGER}`), listItem("third")],
      },
    ]);
    applySlashCommand(instance, range, item("table"), catalog());

    expect(blockTypes(instance)).toEqual(["bullet_list", "table"]);
    expect(instance.state.doc.firstChild?.childCount).toBe(3);
    expect(instance.state.doc.firstChild?.textContent).toBe("firstsecond third");
  });

  /**
   * Where the picture is asked for, rather than where the writer is standing
   * when the file comes back. The host's chooser outlives the pick, so the lane
   * hands over an anchored place and nothing else; a picker reading the
   * selection then is what put a cell's picture past the whole table.
   */
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
