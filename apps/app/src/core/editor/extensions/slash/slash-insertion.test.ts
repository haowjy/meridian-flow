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

  it("opens a code block and a diagram with the caret in the fence", () => {
    const fence = mountWithTrigger("", "/code");
    applySlashCommand(fence.editor, fence.range, item("code"), catalog());
    expect(caretChain(fence.editor)).toEqual(["code_block"]);
    expect(fence.editor.state.doc.firstChild?.textContent).toBe("");

    fence.editor.destroy();

    const diagram = mountWithTrigger("", "/diagram");
    applySlashCommand(diagram.editor, diagram.range, item("diagram"), catalog());
    const node = diagram.editor.state.doc.firstChild;
    expect(node?.type.name).toBe("code_block");
    expect(node?.attrs.language).toBe("mermaid");
    expect(node?.textContent).toContain("flowchart");
    expect(caretChain(diagram.editor)).toEqual(["code_block"]);
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
