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
  CHANGE_META,
  newChangeId,
  type Run,
  rewrite,
  runs,
  type SuggestionAttrs,
  suggested,
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
  /** Per block, the change the text a write cut from its end belongs to: a block inserted right after joins it. */
  const tails = new Map<Y.XmlElement, SuggestionAttrs>();
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
      // Nothing in the block that the view hides or marks: view units are stored units.
      if (view.work === null && viewBlock(before, view) === before) {
        const applied = base.applyOps(doc, block, ops);
        written(unwrapBlock(block));
        return applied;
      }
      const out = rewritten(before, ops, view, author, schema);
      if (typeof out === "string") return refused(out);
      const applied = applyRawOps(unwrapBlock(block), lowerBlock(before, out.node));
      written(unwrapBlock(block), out.node);
      if (out.endChange) tails.set(unwrapBlock(block), out.endChange);
      return applied;
    },

    insertBlocks(doc, after, parsed) {
      const view = viewOf(unwrapDoc(doc));
      if (view.work === null || !author) return base.insertBlocks(doc, after, parsed);
      const sug = (after && tails.get(unwrapBlock(after))) ?? {
        ...author,
        work: view.work,
        id: newChangeId(),
      };
      if (after) tails.delete(unwrapBlock(after));
      return base.insertBlocks(doc, after, {
        ...parsed,
        blocks: parsed.blocks.map((node) => suggested(node, sug)),
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

/**
 * A block's edits, planned in the view, replayed on the stored block as one ProseMirror
 * transaction and rewritten, as a keystroke is. Every op addresses the block as it was, so each
 * position is read there and mapped through the steps before it. `endChange` is the change the
 * text a Work's edit cut from the block's visible end belongs to: a block inserted right after it
 * is the other half of a split. A string says why the write cannot be suggested.
 */
function rewritten(
  node: PMNode,
  ops: readonly EditOp[],
  view: View,
  author: Author | null,
  schema: Schema,
): { node: PMNode; endChange: SuggestionAttrs | null } | string {
  const state = EditorState.create({ schema, doc: schema.topNodeType.create(null, node) });
  const tr = state.tr;
  const map = (pos: number, assoc = 1) => tr.mapping.map(pos, assoc);
  const live = view.work !== null && blockKind(node, view) !== "own";
  let endStep: number | null = null;
  for (const op of ops) {
    const target = locate(state.doc, op.path, view);
    if (!target) return "the write does not fit the block";
    if (op.kind === "delete") {
      if (live && !("sug" in target.node.attrs))
        return "a table's rows and columns are not suggested";
      tr.delete(map(target.pos, 1), map(target.pos + target.node.nodeSize, -1));
    } else if (op.kind === "insert") {
      if (live && op.nodes.some((inserted) => !("sug" in inserted.attrs)))
        return "a table's rows and columns are not suggested";
      tr.insert(map(childEnd(target, op.after, view), -1), [...op.nodes]);
    } else if (op.kind === "attrs") {
      let at = target.pos;
      if (op.unit !== undefined) {
        if (live) return "a picture's attributes are not suggested";
        at = target.pos + 1 + rawUnit(runs(target.node, view), op.unit, "start");
      }
      for (const [key, value] of Object.entries(op.attrs)) tr.setNodeAttribute(map(at), key, value);
    } else {
      const units = runs(target.node, view);
      const start = target.pos + 1;
      const end = units.reduce((n, run) => n + (visible(run.kind) ? run.to - run.from : 0), 0);
      // Formats are planned on the text before the splices and do not move positions: first.
      for (const { from, to, mark, attrs } of op.formats) {
        const a = map(start + rawUnit(units, from, "start"));
        const b = Math.max(a, map(start + rawUnit(units, to, "end"), -1));
        const type = schema.marks[mark.split("--")[0]];
        if (attrs) tr.addMark(a, b, type.create(attrs));
        else
          tr.doc.nodesBetween(a, b, (child) => {
            for (const held of child.marks)
              if (yjsMarkKey(held) === mark) tr.removeMark(a, b, held);
          });
      }
      for (const { from, to, content } of [...op.splices].sort((x, y) => y.from - x.from)) {
        const a = map(start + rawUnit(units, from, from === to ? "end" : "start"));
        const b = from === to ? a : Math.max(a, map(start + rawUnit(units, to, "end"), -1));
        const step = tr.steps.length;
        if (content.size > 0) tr.replaceWith(a, b, content);
        else if (b > a) tr.delete(a, b);
        if (op.path.length === 0 && from < to && to === end && tr.steps.length > step)
          endStep = step;
      }
    }
  }
  const out = rewrite(tr, state, view, author);
  if (out.doc.childCount !== 1) return "the write does not fit the block";
  const changes = (out.getMeta(CHANGE_META) as Array<SuggestionAttrs | null> | undefined) ?? [];
  return {
    node: out.doc.child(0),
    endChange: endStep === null ? null : (changes[endStep] ?? null),
  };
}

/** The node at `path` (child indexes in the view, which leaves out hidden blocks) in `doc`'s block. */
function locate(
  doc: PMNode,
  path: readonly number[],
  view: View,
): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = { node: doc.child(0), pos: 0 };
  for (const index of path) {
    const parent: { node: PMNode; pos: number } = found;
    found = null;
    let seen = -1;
    parent.node.forEach((child, offset) => {
      if (found || !shownChild(child, view)) return;
      seen += 1;
      if (seen === index) found = { node: child, pos: parent.pos + 1 + offset };
    });
    if (!found) return null;
  }
  return found;
}

/** Where a node goes in `container` after its shown child `after` (-1: first). */
function childEnd(container: { node: PMNode; pos: number }, after: number, view: View): number {
  let at = container.pos + 1;
  let seen = -1;
  container.node.forEach((child, offset) => {
    if (seen >= after) return;
    if (shownChild(child, view)) seen += 1;
    at = container.pos + 1 + offset + child.nodeSize;
  });
  return after < 0 ? container.pos + 1 : at;
}

function shownChild(child: PMNode, view: View): boolean {
  return child.isInline || !("sug" in child.attrs) || blockKind(child, view) !== "hidden";
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
 * Each document's stored blocks, suggestions and all, for its current state: the model reads them
 * per block, many times per write. Filled by one repaired read of the fragment; a block a write
 * changed or added is converted alone.
 */
const projections = new WeakMap<Y.Doc, Map<Y.XmlElement, PMNode>>();

function projectionsOf(doc: Y.Doc, schema: Schema): Map<Y.XmlElement, PMNode> {
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
  return nodes;
}

/**
 * A write inside the model's transaction, which `afterTransaction` has not seen yet: the block's
 * new stored node when the write knows it, else the next read converts that block alone.
 */
function written(element: Y.XmlElement, node?: PMNode): void {
  const nodes = projections.get(element.doc as Y.Doc);
  if (!nodes) return;
  if (node) nodes.set(element, node);
  else nodes.delete(element);
}

function storedNode(element: Y.XmlElement, schema: Schema): PMNode {
  const nodes = projectionsOf(element.doc as Y.Doc, schema);
  let node = nodes.get(element);
  if (!node) {
    // Only a block this write made or changed, from schema-valid nodes: no repair to run. The
    // binding converts a fragment; a reused one would keep every deleted item and slow each read.
    const scratch = new Y.Doc();
    const fragment = scratch.getXmlFragment("block");
    fragment.insert(0, [element.clone()]);
    node = yXmlFragmentToProseMirrorRootNode(fragment, schema).child(0);
    scratch.destroy();
    nodes.set(element, node);
  }
  return node;
}
