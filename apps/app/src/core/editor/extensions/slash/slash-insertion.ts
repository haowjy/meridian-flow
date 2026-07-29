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
import type { NodeType, Node as PMNode, ResolvedPos, Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Selection } from "@tiptap/pm/state";

import { defaultDiagramProvider } from "../../diagrams";
import { engageObject } from "../../objects";
import type { SlashCommandCatalog, SlashCommandId, SlashCommandItem } from "./slash-catalog";

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
  /**
   * The host puts this one in the document: a picker, then an upload or a
   * paste. Two things follow. The lane's own job ends at consuming the
   * trigger, and the entry never CONVERTS — the host adds a block at the
   * caret rather than retyping the block the writer is standing in, so an
   * empty paragraph is a place to insert beside, not a thing to become.
   *
   * That second part is what makes `Image` refuse in an empty table cell
   * (ruling). A cell holds one plain paragraph and the image lands in a
   * paragraph too, so asking "may this replace the empty one" answered yes
   * and sent the pick out through the picker, which put the image past the
   * table. The honest question is whether the cell has room for another
   * block, and it never does.
   */
  hostDispatched?: boolean;
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
 * One row per catalog id, `image` included. The picker is the host's and so is
 * the dispatch, but the SHAPE an image lands is known here — a paragraph — and
 * availability has to be answerable for every visible row, including that one.
 */
const SLASH_INSERTIONS: Record<SlashCommandId, SlashInsertion> = {
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
  // "Diagram" means the catalog's first provider, and its starter source comes
  // from the same row (law 2's sole auto-edit: a new diagram has nothing to view
  // yet, so it opens on something that draws). Other dialects are reached
  // through the fence's language menu rather than a slash entry each.
  diagram: diagramInsertion(),
  code: { node: { type: "code_block" }, caret: "inside" },
  image: { node: emptyParagraph, caret: "inside", hostDispatched: true },
};

function diagramInsertion(): SlashInsertion {
  const provider = defaultDiagramProvider();
  return {
    node: {
      type: "code_block",
      attrs: { language: provider.language },
      content: [{ type: "text", text: provider.starterSource }],
    },
    caret: "inside",
  };
}

/** The type an entry would put in the document, for asking whether it may. */
function insertionType(schema: Schema, id: SlashCommandId): NodeType | null {
  return schema.nodes[SLASH_INSERTIONS[id].node.type as string] ?? null;
}

/**
 * Why each entry cannot apply where the trigger sits, computed once against
 * the document a pick would act on. An id absent from the map works here.
 *
 * The menu asks this to grey rows and say why (law 5): a writer in a table
 * cell must learn that the cell holds plain paragraphs, not watch nine rows do
 * nothing or, worse, watch one throw their caret outside the table.
 */
export function slashRefusals(
  editor: Editor,
  range: Range,
  items: readonly SlashCommandItem[],
): ReadonlyMap<SlashCommandId, SlashRefusal> {
  const landing = editor.state.tr.delete(range.from, range.to);
  const pos = landing.mapping.map(range.from);
  const refusals = new Map<SlashCommandId, SlashRefusal>();

  for (const item of items) {
    const insertion = SLASH_INSERTIONS[item.id];
    const type = insertionType(editor.schema, item.id);
    const target =
      type && slashTarget(landing.doc, pos, type, { converts: !insertion.hostDispatched });
    if (target?.mode === "blocked") refusals.set(item.id, target.reason);
  }
  return refusals;
}

/**
 * Why an entry cannot apply where the caret is. The spelling is the toolbar's
 * (`BlockTypeRefusalReason`) so one refusal reads the same wherever a writer
 * meets it; the surface renders it through that module's copy.
 */
export type SlashRefusal = "table-cell";

export type SlashTarget =
  /** The block the writer typed `/` in becomes the new node. */
  | { mode: "convert"; from: number; to: number }
  /** The block keeps its text and the new node lands after it. */
  | { mode: "insert-after"; pos: number }
  /** Nowhere this entry may land without leaving the writer's structure. */
  | { mode: "blocked"; reason: SlashRefusal };

/**
 * Nodes whose parts are not free-standing blocks: a list item exists only as
 * part of its list, so a block asked for from inside a bullet belongs after
 * the whole list rather than wedged into the bullet. A blockquote is
 * deliberately absent — its children ARE ordinary blocks that happen to be
 * quoted, and a writer quoting a passage who asks for a code block wants it in
 * the quote.
 *
 * A table is absent for the opposite reason: a cell is never escaped at all
 * (see `cellFloor`), so there is nothing to walk out of.
 *
 * Only the insert-after walk consults this. Convert cannot reach inside a list
 * item, which must open with a paragraph, so the schema refuses it there.
 */
const OWNING_STRUCTURES: ReadonlySet<string> = new Set([
  "bullet_list",
  "ordered_list",
  "list_item",
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
 * the bullet (`list_item` permits `paragraph block*`). Structure is a domain
 * question here, not a schema one.
 *
 * The walk has a ceiling as well as a direction: **a table cell is never left**
 * (ruling). §5.7 lets `/` open in a cell, and a pick that answered by inserting
 * after the whole table would yank the caret out of the structure the writer is
 * standing in — the deepest owner, law 4. A Meridian cell holds one plain
 * paragraph, so most entries have nowhere to go there and say so instead.
 *
 * Returns null only when nothing from the caret up to the document will hold
 * the node, which no trigger position can produce; blocked is the refusal a
 * writer can read.
 */
export function slashTarget(
  doc: PMNode,
  pos: number,
  type: NodeType,
  { converts = true }: { converts?: boolean } = {},
): SlashTarget | null {
  const $pos = doc.resolve(pos);
  const depth = $pos.depth;
  if (depth === 0) return null;

  const index = $pos.index(depth - 1);
  const convertible =
    converts &&
    $pos.parent.type.name === "paragraph" &&
    $pos.parent.content.size === 0 &&
    $pos.node(depth - 1).canReplaceWith(index, index + 1, type);
  if (convertible) return { mode: "convert", from: $pos.before(depth), to: $pos.after(depth) };

  // Start outside every owning structure the caret is in — the outermost one,
  // so a nested list is escaped whole — then take the first level that will
  // hold the node, stopping inside the cell when there is one.
  const floor = cellFloor($pos);
  for (let level = escapedDepth($pos, floor); level > floor; level -= 1) {
    const parent = $pos.node(level - 1);
    const insertIndex = $pos.indexAfter(level - 1);
    if (parent.canReplaceWith(insertIndex, insertIndex, type)) {
      return { mode: "insert-after", pos: $pos.after(level) };
    }
  }
  return floor > 0 ? { mode: "blocked", reason: "table-cell" } : null;
}

/**
 * The depth of the cell the caret is in, or 0 outside a table. Read from the
 * schema's `tableRole` rather than a node name, because that is what makes a
 * cell a cell to prosemirror-tables.
 */
function cellFloor($pos: ResolvedPos): number {
  for (let level = $pos.depth; level >= 1; level -= 1) {
    const role = $pos.node(level).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") return level;
  }
  return 0;
}

/** The depth whose node the insertion goes after: the outermost owning structure above the floor, else the block itself. */
function escapedDepth($pos: ResolvedPos, floor: number): number {
  for (let level = floor + 1; level <= $pos.depth; level += 1) {
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
  const insertion = SLASH_INSERTIONS[item.id];
  const node = editor.schema.nodeFromJSON(insertion.node);

  // Decided against the document the delete will produce, and decided BEFORE
  // anything is dispatched: TipTap dispatches a chain's transaction even when
  // one of its commands declines, so resolving the target inside the chain
  // would let a refusal eat the trigger text and insert nothing in its place.
  // A refusal therefore costs the writer nothing — not even the `/` they typed.
  const deleted = editor.state.tr.delete(range.from, range.to);
  const target = slashTarget(deleted.doc, deleted.mapping.map(range.from), node.type, {
    converts: !insertion.hostDispatched,
  });
  if (!target || target.mode === "blocked") return false;

  if (insertion.hostDispatched) {
    const consumed = editor.chain().focus().deleteRange(range).run();
    catalog.requestImageUpload();
    return consumed;
  }

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
