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
import type { NodeType, Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Selection } from "@tiptap/pm/state";

import { engageObject } from "../../objects";
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
 * Nodes whose parts are not free-standing blocks. A list item exists only as
 * part of its list, a cell only as part of its table, so a block asked for
 * from inside one belongs after the whole structure rather than wedged into
 * a bullet. A blockquote is deliberately absent: its children ARE ordinary
 * blocks that happen to be quoted, and a writer quoting a passage who asks for
 * a code block wants it in the quote.
 *
 * Only the insert-after walk consults this. Convert cannot reach inside one:
 * a cell holds a single `paragraph` and a list item must open with one, so the
 * schema refuses every conversion an owning structure could hold.
 */
const OWNING_STRUCTURES: ReadonlySet<string> = new Set([
  "bullet_list",
  "ordered_list",
  "list_item",
  "table",
  "table_row",
  "table_header",
  "table_cell",
]);

/**
 * Where the chosen node goes, decided from the document AFTER the `/` and its
 * filter text are gone — so "is this block empty" is a plain question about
 * the block rather than arithmetic on the trigger's range.
 *
 * The outward search is the lane's own rather than prosemirror-transform's
 * `insertPoint`, which answers a different question. `insertPoint` takes the
 * first schema-legal parent and stops climbing the moment the position has a
 * sibling on the relevant side, so from a list item it lands a table INSIDE
 * the bullet (`list_item` permits `paragraph block*`), and from any cell but
 * the last it returns null and the visible command silently does nothing
 * (law 5). Structure is a domain question here, not a schema one.
 *
 * Returns null only when nothing from the caret up to the document will hold
 * the node; the caller declines rather than dropping it somewhere surprising.
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

  // Start outside every owning structure the caret is in — the outermost one,
  // so a nested list is escaped whole — then take the first level that will
  // hold the node. `doc` accepts `block+`, so the walk always has a floor.
  for (let level = escapedDepth($pos); level >= 1; level -= 1) {
    const parent = $pos.node(level - 1);
    const insertIndex = $pos.indexAfter(level - 1);
    if (parent.canReplaceWith(insertIndex, insertIndex, type)) {
      return { mode: "insert-after", pos: $pos.after(level) };
    }
  }
  return null;
}

/** The depth whose node the insertion goes after: the outermost owning structure, else the block itself. */
function escapedDepth($pos: ResolvedPos): number {
  for (let level = 1; level <= $pos.depth; level += 1) {
    if (OWNING_STRUCTURES.has($pos.node(level).type.name)) return level;
  }
  return $pos.depth;
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
    catalog.requestImageUpload();
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

  const start = target.mode === "convert" ? target.from : target.pos;
  const applied = editor
    .chain()
    .focus()
    .deleteRange(range)
    .command(({ tr, dispatch }) => {
      if (!dispatch) return true;

      if (target.mode === "convert") tr.replaceWith(target.from, target.to, node);
      else tr.insert(target.pos, node);

      landCaret(tr, start, node.nodeSize, insertion.caret);
      return true;
    })
    .run();

  if (applied) openNewObject(editor, start);
  return applied;
}

/**
 * Law 2's one exception: a just-created object has nothing to view yet, so it
 * opens ready to edit. Which objects those are is the object table's answer,
 * not a second list here — a type registered `engage: "surface"` gets the same
 * surface Enter would open, and everything else keeps the caret this module
 * already placed.
 *
 * The diagram is the only entry that reaches this today, and `"created"` is
 * what makes its opening the one the mockups draw: the object lane reads it
 * and opens the dialog on the starter source rather than on a picture nobody
 * has written yet. The caret this insertion already placed inside the fence is
 * where the writer lands if they close that dialog without touching it.
 */
function openNewObject(editor: Editor, pos: number) {
  const landed = editor.state.doc.nodeAt(pos);
  if (landed) engageObject(editor, { node: landed, pos }, "created");
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
