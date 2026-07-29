/**
 * What a slash choice does to the document: which node it makes, where that
 * node lands, and where the caret ends up.
 *
 * Two rules from §5.7 shape everything here.
 *
 * **Entries create, they never restyle** (F4, law 6). Picking "Heading 2" in
 * the middle of a paragraph makes a NEW heading after it; it does not retype
 * the sentence the writer is standing in. The one apparent exception is the
 * empty paragraph, which converts — but converting an empty block is creating,
 * since there is nothing there to restyle.
 *
 * **Every insertion opens ready to work** (law 2). A table lands with the
 * caret in its first cell, a code block with the caret in the fence, a
 * heading with the caret in the heading. Landing the caret elsewhere would
 * make the writer's next act "find the thing I just asked for".
 */

import type { Editor, JSONContent, Range } from "@tiptap/core";
import type { NodeType, Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Selection } from "@tiptap/pm/state";
import { insertPoint } from "@tiptap/pm/transform";

import type { SlashCommandCatalog, SlashCommandId, SlashCommandItem } from "./slash-catalog";

/**
 * Starter source for a new diagram, so the writer sees a diagram rather than
 * an empty fence (law 2's sole auto-edit: there is nothing to view yet). Not
 * localized: mermaid keywords are syntax, and the two node labels are document
 * content the writer overwrites immediately.
 */
const DIAGRAM_STARTER_SOURCE = "flowchart TD\n  A[Start] --> B[Next]";

const TABLE_COLUMNS = 3;
const TABLE_ROWS = 3;

type SlashInsertion = {
  /** The node the entry creates, in the schema's own JSON. */
  node: JSONContent;
  /**
   * `inside` puts the caret at the first text position within the new node.
   * `after` is for a node with no inside — a divider — and guarantees a line
   * to keep typing on.
   */
  caret: "inside" | "after";
};

const emptyParagraph: JSONContent = { type: "paragraph" };

const listItem: JSONContent = { type: "list_item", content: [emptyParagraph] };

function tableRow(cell: "table_header" | "table_cell"): JSONContent {
  return {
    type: "table_row",
    content: Array.from({ length: TABLE_COLUMNS }, () => ({
      type: cell,
      content: [emptyParagraph],
    })),
  };
}

function heading(level: 1 | 2 | 3): SlashInsertion {
  return { node: { type: "heading", attrs: { level } }, caret: "inside" };
}

/**
 * One row per catalog id, minus `image`: an image arrives through the host's
 * picker or a paste, so the menu's whole job there is to consume the `/`.
 */
const SLASH_INSERTIONS: Record<Exclude<SlashCommandId, "image">, SlashInsertion> = {
  "heading-1": heading(1),
  "heading-2": heading(2),
  "heading-3": heading(3),
  "bullet-list": { node: { type: "bullet_list", content: [listItem] }, caret: "inside" },
  "numbered-list": { node: { type: "ordered_list", content: [listItem] }, caret: "inside" },
  quote: { node: { type: "blockquote", content: [emptyParagraph] }, caret: "inside" },
  divider: { node: { type: "horizontal_rule" }, caret: "after" },
  table: {
    node: {
      type: "table",
      content: [
        tableRow("table_header"),
        ...Array.from({ length: TABLE_ROWS - 1 }, () => tableRow("table_cell")),
      ],
    },
    caret: "inside",
  },
  diagram: {
    node: {
      type: "code_block",
      attrs: { language: "mermaid" },
      content: [{ type: "text", text: DIAGRAM_STARTER_SOURCE }],
    },
    caret: "inside",
  },
  code: { node: { type: "code_block" }, caret: "inside" },
};

export type SlashTarget =
  /** The block the writer typed `/` in becomes the new node. */
  | { mode: "convert"; from: number; to: number }
  /** The block keeps its text and the new node lands after it. */
  | { mode: "insert-after"; pos: number };

/**
 * Where the chosen node goes, decided from the document AFTER the `/` and its
 * filter text are gone — so "is this block empty" is a plain question about
 * the block rather than arithmetic on the trigger's range.
 *
 * Returns null when the schema will not take the node anywhere near the caret;
 * the caller declines rather than dropping it somewhere surprising.
 */
export function slashTarget(doc: PMNode, pos: number, type: NodeType): SlashTarget | null {
  const $pos = doc.resolve(pos);
  const depth = $pos.depth;
  if (depth === 0) return null;

  const index = $pos.index(depth - 1);
  const convertible =
    $pos.parent.type.name === "paragraph" &&
    $pos.parent.content.size === 0 &&
    $pos.node(depth - 1).canReplaceWith(index, index + 1, type);
  if (convertible) return { mode: "convert", from: $pos.before(depth), to: $pos.after(depth) };

  // Searching outward from just after the block is what puts a table after the
  // whole list rather than inside a list item that cannot hold one.
  const pointAfter = insertPoint(doc, $pos.after(depth), type);
  return pointAfter === null ? null : { mode: "insert-after", pos: pointAfter };
}

/** Runs the writer's choice: consume the trigger text, make the node, land the caret. */
export function applySlashCommand(
  editor: Editor,
  range: Range,
  item: SlashCommandItem,
  catalog: SlashCommandCatalog,
): boolean {
  if (item.id === "image") {
    const consumed = editor.chain().focus().deleteRange(range).run();
    catalog.requestImageUpload?.();
    return consumed;
  }

  const insertion = SLASH_INSERTIONS[item.id];
  const node = editor.schema.nodeFromJSON(insertion.node);

  // Decided against the document the delete will produce, and decided BEFORE
  // anything is dispatched: TipTap dispatches a chain's transaction even when
  // one of its commands declines, so resolving the target inside the chain
  // would let a refusal eat the trigger text and insert nothing in its place.
  const deleted = editor.state.tr.delete(range.from, range.to);
  const target = slashTarget(deleted.doc, deleted.mapping.map(range.from), node.type);
  if (!target) return false;

  return editor
    .chain()
    .focus()
    .deleteRange(range)
    .command(({ tr, dispatch }) => {
      if (!dispatch) return true;

      const start = target.mode === "convert" ? target.from : target.pos;
      if (target.mode === "convert") tr.replaceWith(target.from, target.to, node);
      else tr.insert(target.pos, node);

      landCaret(tr, start, node.nodeSize, insertion.caret);
      return true;
    })
    .run();
}

function landCaret(tr: Transaction, start: number, size: number, caret: "inside" | "after") {
  const end = start + size;
  const forwardFrom = caret === "inside" ? start + 1 : end;
  const found = Selection.findFrom(tr.doc.resolve(forwardFrom), 1, true);

  if (found) {
    tr.setSelection(found).scrollIntoView();
    return;
  }

  // Nothing to type into ahead: a divider that landed at the end of the
  // document. The writer asked for a break, not for a dead end.
  const paragraph = tr.doc.type.schema.nodes.paragraph?.createAndFill();
  if (!paragraph) return;
  tr.insert(end, paragraph);
  const landing = Selection.findFrom(tr.doc.resolve(end), 1, true);
  if (landing) tr.setSelection(landing).scrollIntoView();
}
