/** Inserts a selected slash-command result into the document. */

import type { Editor, JSONContent, Range } from "@tiptap/core";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Selection } from "@tiptap/pm/state";

import { anchorRange } from "../../anchors";
import { defaultDiagramProvider } from "../../diagrams";
import { acceptsInlineImage } from "../../images";
import { engageObject } from "../../objects";
import type { SlashCommandCatalog, SlashCommandId, SlashCommandItem } from "./slash-catalog";

const TABLE_COLUMNS = 3;
const TABLE_ROWS = 3;

/** The node a block entry makes, and where its caret lands inside it. */
type SlashBlock = {
  /** The node the entry creates, in the schema's own JSON. */
  node: JSONContent;
  /** `inside` puts the caret at the first text position within the new node. */
  caret: "inside" | "after";
};

/** What an entry lands, which is the question availability has to ask. */
type SlashInsertion =
  | ({ strategy: "block" } & SlashBlock)
  /** A picture, inline where the trigger was. */
  | { strategy: "image" };

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

function block(node: JSONContent, caret: "inside" | "after" = "inside"): SlashInsertion {
  return { strategy: "block", node, caret };
}

function heading(level: 1 | 2 | 3): SlashInsertion {
  return block({ type: "heading", attrs: { level } });
}

/** One row per catalog id, `image` included. */
const SLASH_INSERTIONS: Record<SlashCommandId, SlashInsertion> = {
  "heading-1": heading(1),
  "heading-2": heading(2),
  "heading-3": heading(3),
  "bullet-list": block({ type: "bullet_list", content: [listItem] }),
  "numbered-list": block({ type: "ordered_list", content: [listItem] }),
  quote: block({ type: "blockquote", content: [emptyParagraph] }),
  divider: block({ type: "horizontal_rule" }, "after"),
  table: block({
    type: "table",
    content: [
      tableRow("table_header"),
      ...Array.from({ length: TABLE_ROWS - 1 }, () => tableRow("table_cell")),
    ],
  }),
  // "Diagram" means the catalog's first provider, and its starter source comes
  // from the same row ( sole auto-edit: a new diagram has nothing to view
  // yet, so it opens on something that draws). Other dialects are reached
  // through the fence's language menu rather than a slash entry each.
  diagram: diagramInsertion(),
  code: block({ type: "code_block" }),
  image: { strategy: "image" },
};

function diagramInsertion(): SlashInsertion {
  const provider = defaultDiagramProvider();
  return block({
    type: "code_block",
    attrs: { language: provider.language },
    content: [{ type: "text", text: provider.starterSource }],
  });
}

type SlashTarget =
  /** The block the writer typed `/` in becomes the new node. */
  | { mode: "convert"; from: number; to: number; block: SlashBlock }
  /** The block keeps its text and the new node lands after it. */
  | { mode: "insert-after"; pos: number; block: SlashBlock }
  /** A picture stands exactly where the trigger was, among the same words. */
  | { mode: "inline"; pos: number };

/** What this entry would do at this position, or null when the schema holds nothing it could make (a surface with no image node, a catalog id whose node type is not in this document's schema). */
function slashTarget(doc: PMNode, pos: number, insertion: SlashInsertion): SlashTarget | null {
  return insertion.strategy === "image"
    ? inlineImageTarget(doc, pos)
    : blockTarget(doc, pos, insertion);
}

/** Where a picture goes: exactly where the trigger was, or nowhere. */
function inlineImageTarget(doc: PMNode, pos: number): SlashTarget | null {
  return acceptsInlineImage(doc, pos) ? { mode: "inline", pos } : null;
}

/** Nodes whose parts are not free-standing blocks: a list item exists only as part of its list, so a block asked for from inside a bullet belongs after the whole list rather than wedged into the bullet. */
const OWNING_STRUCTURES: ReadonlySet<string> = new Set([
  "bullet_list",
  "ordered_list",
  "list_item",
]);

/** Where the chosen node goes, decided from the document AFTER the `/` and its filter text are gone — so "is this block empty" is a plain question about the block rather than arithmetic on the trigger's range. */
function blockTarget(doc: PMNode, pos: number, block: SlashBlock): SlashTarget | null {
  const type = doc.type.schema.nodes[block.node.type as string];
  const $pos = doc.resolve(pos);
  const depth = $pos.depth;
  if (!type || depth === 0) return null;

  const index = $pos.index(depth - 1);
  const convertible =
    $pos.parent.type.name === "paragraph" &&
    $pos.parent.content.size === 0 &&
    $pos.node(depth - 1).canReplaceWith(index, index + 1, type);
  if (convertible) {
    return { mode: "convert", from: $pos.before(depth), to: $pos.after(depth), block };
  }

  // Start outside every owning structure the caret is in — the outermost one,
  // so a nested list is escaped whole — then take the first level that will
  // hold the node, stopping inside the cell when there is one.
  const floor = cellFloor($pos);
  for (let level = escapedDepth($pos, floor); level > floor; level -= 1) {
    const parent = $pos.node(level - 1);
    const insertIndex = $pos.indexAfter(level - 1);
    if (parent.canReplaceWith(insertIndex, insertIndex, type)) {
      return { mode: "insert-after", pos: $pos.after(level), block };
    }
  }
  return null;
}

/** The depth of the cell the caret is in, or 0 outside a table. */
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
  // Decided against the document the delete will produce, and decided BEFORE
  // anything is dispatched: TipTap dispatches a chain's transaction even when
  // one of its commands declines, so resolving the target inside the chain
  // would let a decline eat the trigger text and insert nothing in its place.
  // A decline therefore costs the writer nothing — not even the `/` they typed.
  const deleted = editor.state.tr.delete(range.from, range.to);
  const at = deleted.mapping.map(range.from);
  const target = slashTarget(deleted.doc, at, SLASH_INSERTIONS[item.id]);
  if (!target) return false;

  if (target.mode === "inline") {
    const consumed = editor.chain().focus().deleteRange(range).run();
    if (!consumed) return false;
    // The place the trigger left behind, pinned before the host opens anything:
    // the operating system's chooser can stay up for a minute, and the writer's
    // own caret and every peer's writes move on without it. `at` describes the
    // document the delete just produced, which is the document this anchor is
    // taken against.
    catalog.requestImageUpload(anchorRange(editor.state, { from: at, to: at }));
    return true;
  }

  const node = editor.schema.nodeFromJSON(target.block.node);
  const start = target.mode === "convert" ? target.from : target.pos;
  const applied = editor
    .chain()
    .focus()
    .deleteRange(range)
    .command(({ tr, dispatch }) => {
      if (!dispatch) return true;

      if (target.mode === "convert") tr.replaceWith(target.from, target.to, node);
      else tr.insert(target.pos, node);

      landCaret(tr, start, node.nodeSize, target.block.caret);
      return true;
    })
    .run();

  if (applied) openNewObject(editor, start);
  return applied;
}

/** one exception: a just-created object has nothing to view yet, so it opens ready to edit. */
function openNewObject(editor: Editor, pos: number) {
  const landed = editor.state.doc.nodeAt(pos);
  if (landed) engageObject(editor, { node: landed, pos }, "created");
}

function landCaret(tr: Transaction, start: number, size: number, caret: "inside" | "after") {
  const end = start + size;
  const forwardFrom = caret === "inside" ? start + 1 : end;
  const found = Selection.findFrom(tr.doc.resolve(forwardFrom), 1, true);

  // The teleport rule holds for the caret too. A forward search from the end
  // of a cell's last block finds the NEXT cell's text, and a divider asked for
  // in a cell would walk the writer into a cell they never touched. A landing
  // outside the cell reads as "nothing ahead", and the fallback paragraph
  // below is the line to keep typing on — inside the cell.
  const $start = tr.doc.resolve(start);
  const floor = cellFloor($start);
  const escaped = found !== null && floor > 0 && found.from > $start.end(floor);

  if (found && !escaped) {
    tr.setSelection(found).scrollIntoView();
    return;
  }

  // Nothing to type into ahead: a divider that landed at the end of the
  // document, or against its cell's wall. The writer asked for a break, not
  // for a dead end.
  const paragraph = tr.doc.type.schema.nodes.paragraph?.createAndFill();
  if (!paragraph) return;
  tr.insert(end, paragraph);
  const landing = Selection.findFrom(tr.doc.resolve(end), 1, true);
  if (landing) tr.setSelection(landing).scrollIntoView();
}
