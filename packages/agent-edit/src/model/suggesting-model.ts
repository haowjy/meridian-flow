/**
 * The model port for suggestion mode: the model reads a view of the document (`@meridian/suggestions`)
 * and its writes go through the same `rewrite` the editor's typing does. A Work's view turns a
 * write into that Work's suggestions; the Live view (`work: null`) writes Live text and leaves
 * every suggestion where it is.
 *
 * The model plans in view units. A text write is replayed as a ProseMirror transaction on the
 * stored block, rewritten, and the result lowered back to operations on the element, so the table
 * that decides what a keystroke does decides what a model write does.
 */
import {
  type Author,
  blockKind,
  newChangeId,
  type Run,
  rewrite,
  runs,
  type View,
  viewBlock,
  visible,
} from "@meridian/suggestions";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import type * as Y from "yjs";
import type { BlockRef } from "../handles.js";
import { unwrapBlock, unwrapDoc } from "../handles.js";
import type { EditOp, EditOpsResult } from "../ports/model.js";
import { lowerBlock } from "../resolver/lower-block.js";
import { getTopLevelXmlBlocks } from "./block-hash.js";
import { readRepairedRoot } from "./schema-repair.js";
import {
  applyOps as applyRawOps,
  fragmentOf,
  type YProsemirrorDocumentModel,
} from "./y-prosemirror.js";

/** `viewOf` reads the view from the document itself: which Works' drafts it has discarded. */
export function suggestingModel(
  base: YProsemirrorDocumentModel,
  viewOf: (doc: Y.Doc) => View,
  author: Author | null,
): YProsemirrorDocumentModel {
  const schema = base.schema;
  const viewAt = (block: BlockRef) => viewOf(unwrapBlock(block).doc as Y.Doc);
  const stored = (block: BlockRef) => storedNode(unwrapBlock(block), schema);
  const shown = (block: BlockRef) => viewBlock(stored(block), viewAt(block));
  return {
    ...base,

    getBlocks: (doc) => base.getBlocks(doc).filter((block) => shown(block) !== null),

    getDocumentBlockIds(doc) {
      const blocks = base.getBlocks(doc);
      const ids = base.getDocumentBlockIds(doc);
      return ids.filter((_, index) => shown(blocks[index]) !== null);
    },

    getText: (block) => shown(block)?.textContent ?? "",

    projectBlocks(doc) {
      const view = viewOf(unwrapDoc(doc));
      return base.projectBlocks(doc).flatMap((projected) => {
        const node = viewBlock(projected.node, view);
        return node ? [{ ...projected, node }] : [];
      });
    },

    textblockLineage(block, path, from, to) {
      if (path.length > 0) return base.textblockLineage(block, path, from, to);
      const units = runs(stored(block), viewAt(block));
      return base.textblockLineage(
        block,
        path,
        rawUnit(units, from, "start"),
        rawUnit(units, to, "end"),
      );
    },

    applyOps(doc, block, ops) {
      const view = viewAt(block);
      const before = stored(block);
      if (
        view.work !== null &&
        blockKind(before, view) !== "own" &&
        ops.some((op) => op.kind !== "text" || op.path.length > 0)
      )
        return refused(
          "a suggestion changes text in a paragraph; this prototype makes no other kind",
        );
      if (ops.some((op) => op.kind === "text" && op.formats.length > 0))
        return refused("formatting is not suggested in this prototype");
      const textOps = ops.filter(
        (op): op is Extract<EditOp, { kind: "text" }> => op.kind === "text" && op.path.length === 0,
      );
      const other = ops.filter((op) => !textOps.includes(op as Extract<EditOp, { kind: "text" }>));
      if (other.length > 0) {
        const applied = base.applyOps(doc, block, other);
        if (!applied.ok || textOps.length === 0) return applied;
      }
      if (textOps.length === 0) return { ok: true };
      const current = other.length > 0 ? stored(block) : before;
      const after = rewritten(current, textOps, view, author, schema);
      if (!after) return refused("the write does not fit the block");
      return applyRawOps(unwrapBlock(block), lowerBlock(current, after));
    },

    insertBlocks(doc, after, parsed) {
      const view = viewOf(unwrapDoc(doc));
      if (view.work === null || !author) return base.insertBlocks(doc, after, parsed);
      const sug = { ...author, work: view.work, id: newChangeId() };
      return base.insertBlocks(doc, after, {
        ...parsed,
        blocks: parsed.blocks.map((node) =>
          node.type.create({ ...node.attrs, sug }, node.content, node.marks),
        ),
      });
    },

    deleteBlock(doc, block) {
      const view = viewAt(block);
      const node = stored(block);
      if (view.work === null || !author || blockKind(node, view) === "own") {
        base.deleteBlock(doc, block);
        return;
      }
      const state = EditorState.create({ schema, doc: schema.topNodeType.create(null, node) });
      const out = rewrite(state.tr.delete(1, 1 + node.content.size), state, view, author);
      applyRawOps(unwrapBlock(block), lowerBlock(node, out.doc.firstChild as PMNode));
    },
  };

  function refused(message: string): EditOpsResult {
    return { ok: false, code: "invalid_write", message: `Cannot apply: ${message}` };
  }
}

/** The text edits of one block, planned in view units, replayed on the stored block and rewritten. */
function rewritten(
  node: PMNode,
  ops: readonly Extract<EditOp, { kind: "text" }>[],
  view: View,
  author: Author | null,
  schema: Schema,
): PMNode | null {
  const state = EditorState.create({ schema, doc: schema.topNodeType.create(null, node) });
  const units = runs(node, view);
  const tr = state.tr;
  const splices = ops.flatMap((op) => op.splices).sort((a, b) => b.from - a.from);
  for (const { from, to, content } of splices) {
    const a = 1 + rawUnit(units, from, from === to ? "end" : "start");
    const b = from === to ? a : Math.max(a, 1 + rawUnit(units, to, "end"));
    if (content.size > 0) tr.replaceWith(a, b, content);
    else if (b > a) tr.delete(a, b);
  }
  const out = rewrite(tr, state, view, author);
  return out.doc.childCount === 1 ? out.doc.firstChild : null;
}

/**
 * A view unit's offset in the stored block. A unit between two shown runs, with hidden text
 * between them, is the end of the earlier run (`end`) or the start of the later one (`start`).
 */
function rawUnit(units: readonly Run[], unit: number, side: "start" | "end"): number {
  let seen = 0;
  let lastEnd = 0;
  for (const run of units) {
    if (!visible(run.kind)) continue;
    const length = run.to - run.from;
    if (unit < seen + length || (unit === seen + length && side === "end"))
      return run.from + (unit - seen);
    seen += length;
    lastEnd = run.to;
  }
  return lastEnd;
}

/**
 * Each document's stored blocks, suggestions and all, projected once per state: the model calls
 * this per block, and a projection reads the whole fragment.
 */
const projections = new WeakMap<Y.Doc, Map<Y.XmlElement, PMNode>>();

function storedNode(element: Y.XmlElement, schema: Schema): PMNode {
  const doc = element.doc as Y.Doc;
  let nodes = projections.get(doc);
  if (!nodes) {
    const root = readRepairedRoot("projectBlocks", fragmentOf(doc), schema);
    const projected = new Map<Y.XmlElement, PMNode>();
    getTopLevelXmlBlocks(doc).forEach((block, index) => {
      projected.set(block, root.child(index));
    });
    nodes = projected;
    projections.set(doc, nodes);
    doc.once("afterTransaction", () => projections.delete(doc));
  }
  const node = nodes.get(element);
  if (!node) throw new Error("A block outside its document's projection");
  return node;
}
