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
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "../../config";
import { type ObjectAt, registerObjectEngagement } from "../../objects";
import type { SlashCommandCatalog, SlashCommandId, SlashCommandItem } from "./slash-catalog";
import { applySlashCommand } from "./slash-insertion";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
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
 * Mounts a document whose last paragraph ends in `trigger`, and returns the
 * range covering it — exactly what `@tiptap/suggestion` hands `command`.
 */
function mountWithTrigger(text: string, trigger: string, trailing: JSONContent[] = []) {
  const line = `${text}${trigger}`;
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [
        line
          ? { type: "paragraph", content: [{ type: "text", text: line }] }
          : { type: "paragraph" },
        ...trailing,
      ],
    },
  });
  const from = 1 + text.length;
  return { editor, range: { from, to: from + trigger.length } };
}

/**
 * Mounts arbitrary structure and finds the `/x` a writer typed inside it, so a
 * nested case reads as the document it is rather than as position arithmetic.
 */
const TRIGGER = "/x";

function mountAround(content: JSONContent[]) {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
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

/** The node types the caret's block chain sits in, outermost first. */
function caretChain(instance: Editor): string[] {
  const { $from } = instance.state.selection;
  return Array.from({ length: $from.depth }, (_, depth) => $from.node(depth + 1).type.name);
}

function blockTypes(instance: Editor): string[] {
  return instance.state.doc.content.content.map((node) => node.type.name);
}

describe("slash insertion semantics", () => {
  it("converts an empty paragraph in place", () => {
    const { editor: instance, range } = mountWithTrigger("", "/head");
    applySlashCommand(instance, range, item("heading-1"), catalog());

    expect(blockTypes(instance)).toEqual(["heading"]);
    expect(instance.state.doc.firstChild?.attrs.level).toBe(1);
    expect(instance.state.doc.firstChild?.textContent).toBe("");
  });

  it("inserts after a paragraph that has content, leaving the sentence alone", () => {
    const { editor: instance, range } = mountWithTrigger("The Warden said nothing. ", "/head");
    applySlashCommand(instance, range, item("heading-2"), catalog());

    expect(blockTypes(instance)).toEqual(["paragraph", "heading"]);
    expect(instance.state.doc.firstChild?.textContent).toBe("The Warden said nothing. ");
    expect(caretChain(instance)).toEqual(["heading"]);
  });

  it("opens a table with the caret in the first cell", () => {
    const { editor: instance, range } = mountWithTrigger("", "/table");
    applySlashCommand(instance, range, item("table"), catalog());

    const table = instance.state.doc.firstChild;
    expect(table?.type.name).toBe("table");
    expect(table?.childCount).toBe(3);
    expect(table?.firstChild?.firstChild?.type.name).toBe("table_header");
    expect(caretChain(instance)).toEqual(["table", "table_row", "table_header", "paragraph"]);
  });

  it("opens a code block with the caret in the fence", () => {
    const { editor: instance, range } = mountWithTrigger("", "/code");
    applySlashCommand(instance, range, item("code"), catalog());

    expect(caretChain(instance)).toEqual(["code_block"]);
    expect(instance.state.doc.firstChild?.textContent).toBe("");
  });

  /**
   * A diagram's readiness is a surface, not a caret: law 2's exception says a
   * just-made object opens ready to edit, and the object lane owns what
   * "open" means for one. This asserts the hand-off rather than the fence,
   * because the fence is what the writer sees only until M5's dialog exists.
   */
  it("hands a new diagram to the object lane, at the position it landed", () => {
    const { editor: instance, range } = mountWithTrigger("The gate stood open. ", "/diagram");
    const opened: ObjectAt[] = [];
    registerObjectEngagement(instance, "code_block", (target) => opened.push(target));

    applySlashCommand(instance, range, item("diagram"), catalog());

    expect(opened).toHaveLength(1);
    expect(instance.state.doc.nodeAt(opened[0].pos)).toBe(opened[0].node);
    expect(opened[0].node.attrs.language).toBe("mermaid");
    expect(opened[0].node.textContent).toContain("flowchart");
  });

  it("leaves a diagram editable in place while no lane has registered its surface", () => {
    const { editor: instance, range } = mountWithTrigger("", "/diagram");
    applySlashCommand(instance, range, item("diagram"), catalog());

    const node = instance.state.doc.firstChild;
    expect(node?.attrs.language).toBe("mermaid");
    expect(node?.textContent).toContain("flowchart");
    expect(caretChain(instance)).toEqual(["code_block"]);
  });

  it("asks no surface for a table: its readiness is the caret in its first cell", () => {
    const { editor: instance, range } = mountWithTrigger("", "/table");
    const opened: ObjectAt[] = [];
    registerObjectEngagement(instance, "table", (target) => opened.push(target));

    applySlashCommand(instance, range, item("table"), catalog());

    expect(opened).toHaveLength(0);
    expect(caretChain(instance)).toEqual(["table", "table_row", "table_header", "paragraph"]);
  });

  it("opens a list with the caret in its first item", () => {
    const { editor: instance, range } = mountWithTrigger("", "/bullet");
    applySlashCommand(instance, range, item("bullet-list"), catalog());

    expect(blockTypes(instance)).toEqual(["bullet_list"]);
    expect(caretChain(instance)).toEqual(["bullet_list", "list_item", "paragraph"]);
  });

  it("gives a divider at the end of the document a line to keep typing on", () => {
    const { editor: instance, range } = mountWithTrigger("She stepped through. ", "/div");
    applySlashCommand(instance, range, item("divider"), catalog());

    expect(blockTypes(instance)).toEqual(["paragraph", "horizontal_rule", "paragraph"]);
    expect(instance.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(instance.state.selection.from).toBeGreaterThan(instance.state.doc.content.size - 3);
  });

  it("lands the caret in the paragraph that already follows a divider", () => {
    const { editor: instance, range } = mountWithTrigger("Before. ", "/div", [
      { type: "paragraph", content: [{ type: "text", text: "After." }] },
    ]);
    applySlashCommand(instance, range, item("divider"), catalog());

    expect(blockTypes(instance)).toEqual(["paragraph", "horizontal_rule", "paragraph"]);
    expect(instance.state.selection.$from.parent.textContent).toBe("After.");
  });

  it("hands the image entry to the host picker and inserts nothing", () => {
    const requestImageUpload = vi.fn();
    const { editor: instance, range } = mountWithTrigger("A portrait: ", "/image");
    applySlashCommand(instance, range, item("image"), catalog(requestImageUpload));

    expect(blockTypes(instance)).toEqual(["paragraph"]);
    expect(instance.state.doc.firstChild?.textContent).toBe("A portrait: ");
    expect(requestImageUpload).toHaveBeenCalledTimes(1);
  });

  it("consumes the trigger text on every path", () => {
    const { editor: instance, range } = mountWithTrigger("Keep this. ", "/quote");
    applySlashCommand(instance, range, item("quote"), catalog());

    expect(instance.state.doc.textContent).toBe("Keep this. ");
    expect(caretChain(instance)).toEqual(["blockquote", "paragraph"]);
  });
});

/**
 * §5.7 says the new block lands "after the current one", and inside a list or
 * a table that sentence needs a level. A list item exists only as part of its
 * list and a cell only as part of its table, so "after" means after the whole
 * structure: a table wedged inside a bullet, or a command that silently does
 * nothing because the cell will not take it (law 5), is not what the writer
 * asked for.
 */
describe("slash insertion out of nested structures", () => {
  it("lands after the whole list, not inside the item", () => {
    const { editor: instance, range } = mountAround([
      { type: "bullet_list", content: [listItem(`hello ${TRIGGER}`)] },
    ]);
    const applied = applySlashCommand(instance, range, item("table"), catalog());

    expect(applied).toBe(true);
    expect(blockTypes(instance)).toEqual(["bullet_list", "table"]);
    expect(instance.state.doc.firstChild?.childCount).toBe(1);
    expect(instance.state.doc.firstChild?.textContent).toBe("hello ");
  });

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

  it("escapes a nested list all the way out", () => {
    const { editor: instance, range } = mountAround([
      {
        type: "bullet_list",
        content: [
          {
            type: "list_item",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "outer" }] },
              { type: "bullet_list", content: [listItem(`inner ${TRIGGER}`)] },
            ],
          },
        ],
      },
    ]);
    applySlashCommand(instance, range, item("table"), catalog());

    expect(blockTypes(instance)).toEqual(["bullet_list", "table"]);
    expect(instance.state.doc.firstChild?.textContent).toBe("outerinner ");
  });

  it("lands after the whole table from any cell", () => {
    for (const target of ["first", "middle", "last"]) {
      const cells = ["first", "middle", "last"].map((name) =>
        cell(name === target ? `${name} ${TRIGGER}` : name),
      );
      const { editor: instance, range } = mountAround([
        { type: "table", content: [row(...cells)] },
      ]);
      const applied = applySlashCommand(instance, range, item("table"), catalog());

      expect(applied, `from the ${target} cell`).toBe(true);
      expect(blockTypes(instance), `from the ${target} cell`).toEqual(["table", "table"]);
      expect(instance.state.doc.firstChild?.textContent).toBe(
        `first${target === "first" ? " " : ""}middle${target === "middle" ? " " : ""}last${target === "last" ? " " : ""}`,
      );
      instance.destroy();
    }
  });

  it("carries a text entry out of a list too", () => {
    const { editor: instance, range } = mountAround([
      { type: "bullet_list", content: [listItem(`hello ${TRIGGER}`)] },
    ]);
    applySlashCommand(instance, range, item("heading-2"), catalog());

    expect(blockTypes(instance)).toEqual(["bullet_list", "heading"]);
    expect(caretChain(instance)).toEqual(["heading"]);
  });

  /**
   * A quote is not an owning structure: its children ARE free-standing blocks
   * that happen to be quoted, so the new one belongs inside it. Pinned because
   * it is the deliberate other side of the rule above.
   */
  it("stays inside a quote", () => {
    const { editor: instance, range } = mountAround([
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [{ type: "text", text: `she wrote ${TRIGGER}` }] }],
      },
    ]);
    applySlashCommand(instance, range, item("code"), catalog());

    expect(blockTypes(instance)).toEqual(["blockquote"]);
    expect(instance.state.doc.firstChild?.content.content.map((node) => node.type.name)).toEqual([
      "paragraph",
      "code_block",
    ]);
    expect(caretChain(instance)).toEqual(["blockquote", "code_block"]);
  });
});
