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
import { yjsMarkKey } from "@meridian/prosemirror-schema";
import {
  type Author,
  blockKind,
  changeIn,
  newChangeId,
  type Run,
  rewrite,
  runs,
  type View,
  viewBlock,
  visible,
} from "@meridian/suggestions";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import * as Y from "yjs";
import type { BlockRef } from "../handles.js";
import { unwrapBlock, unwrapDoc } from "../handles.js";
import type { EditOp, EditOpsResult } from "../ports/model.js";
import { lowerBlock } from "../resolver/lower-block.js";
import { applyOps as applyRawOps, type YProsemirrorDocumentModel } from "./y-prosemirror.js";

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
      if (view.work !== null && ops.some((op) => op.kind === "text" && op.formats.length > 0))
        return refused("formatting is not suggested in this prototype");
      // Nothing in the block that the view hides or marks: view units are stored units.
      if (view.work === null && viewBlock(before, view) === before) {
        const applied = base.applyOps(doc, block, ops);
        written(unwrapBlock(block));
        return applied;
      }
      const textOps = ops.filter(
        (op): op is Extract<EditOp, { kind: "text" }> => op.kind === "text" && op.path.length === 0,
      );
      const other = ops.filter((op) => !textOps.includes(op as Extract<EditOp, { kind: "text" }>));
      if (other.length > 0) {
        const applied = base.applyOps(doc, block, other);
        written(unwrapBlock(block));
        if (!applied.ok || textOps.length === 0) return applied;
      }
      if (textOps.length === 0) return { ok: true };
      const current = stored(block);
      const after = rewritten(current, textOps, view, author, schema);
      if (!after) return refused("the write does not fit the block");
      const applied = applyRawOps(unwrapBlock(block), lowerBlock(current, after));
      written(unwrapBlock(block), after);
      return applied;
    },

    insertBlocks(doc, after, parsed) {
      const view = viewOf(unwrapDoc(doc));
      if (view.work === null || !author) return base.insertBlocks(doc, after, parsed);
      // A block a write adds after its own edit of the block before is part of that change.
      const id =
        (after && changeIn(stored(after), { ...author, work: view.work })) ?? newChangeId();
      const sug = { ...author, work: view.work, id };
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
      const after = out.doc.firstChild as PMNode;
      applyRawOps(unwrapBlock(block), lowerBlock(node, after));
      written(unwrapBlock(block), after);
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
  // Formats are planned on the text before the splices and do not move positions: first.
  for (const { from, to, mark, attrs } of ops.flatMap((op) => op.formats)) {
    const a = 1 + rawUnit(units, from, "start");
    const b = Math.max(a, 1 + rawUnit(units, to, "end"));
    const type = schema.marks[mark.split("--")[0]];
    if (attrs) tr.addMark(a, b, type.create(attrs));
    else
      tr.doc.nodesBetween(a, b, (child) => {
        for (const held of child.marks) if (yjsMarkKey(held) === mark) tr.removeMark(a, b, held);
      });
  }
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
 * Stored blocks, suggestions and all, projected one block at a time and kept for the document's
 * current state: the model reads them per block, many times per write.
 */
const projections = new WeakMap<Y.Doc, Map<Y.XmlElement, PMNode>>();

function projectionsOf(doc: Y.Doc): Map<Y.XmlElement, PMNode> {
  let nodes = projections.get(doc);
  if (!nodes) {
    nodes = new Map();
    projections.set(doc, nodes);
    doc.once("afterTransaction", () => projections.delete(doc));
  }
  return nodes;
}

/**
 * A write inside the model's transaction, which `afterTransaction` has not seen yet: the block's
 * new stored node when the write knows it, else the next read projects that block again.
 */
function written(element: Y.XmlElement, node?: PMNode): void {
  const nodes = projectionsOf(element.doc as Y.Doc);
  if (node) nodes.set(element, node);
  else nodes.delete(element);
}

function storedNode(element: Y.XmlElement, schema: Schema): PMNode {
  const nodes = projectionsOf(element.doc as Y.Doc);
  let node = nodes.get(element);
  if (!node) {
    // The binding converts a fragment, so the block goes through one of its own.
    const scratch = new Y.Doc();
    const fragment = scratch.getXmlFragment("block");
    fragment.insert(0, [element.clone()]);
    node = yXmlFragmentToProseMirrorRootNode(fragment, schema).child(0);
    scratch.destroy();
    nodes.set(element, node);
  }
  return node;
}
