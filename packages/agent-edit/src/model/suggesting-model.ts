/**
 * The model port for suggestion mode: the model reads a view of the document (`@meridian/suggestions`)
 * and its writes go through the same `rewrite` the editor's typing does. A draft's view turns a
 * write into that draft's suggestions; the Live view (`draft: null`) writes Live text and leaves
 * every suggestion where it is.
 *
 * The model plans in view units. A text write is replayed as a ProseMirror transaction on the
 * stored block, rewritten, and the result lowered back to operations on the element, so the table
 * that decides what a keystroke does decides what a model write does.
 */
import { yjsMarkKey } from "@meridian/prosemirror-schema";
import {
  type Author,
  type Authors,
  blockKind,
  CHANGE_META,
  type ChangeAt,
  DROPPED_META,
  newChangeId,
  type Run,
  recordStarted,
  rewrite,
  runs,
  type SuggestionAttrs,
  suggested,
  type View,
  viewBlock,
  visible,
} from "@meridian/suggestions";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import type * as Y from "yjs";
import { heldBlocks } from "../diff/fragments.js";
import type { BlockRef } from "../handles.js";
import { unwrapBlock, unwrapDoc } from "../handles.js";
import type { EditOp, EditOpsResult } from "../ports/model.js";
import { lowerBlock } from "../resolver/lower-block.js";
import { suggestionAuthors } from "./stored-suggestions.js";
import { applyOps as applyRawOps, type YProsemirrorDocumentModel } from "./y-prosemirror.js";

/** The model of `view` over `base`, the stored document; a write in a Work's view is by `author`. */
export function suggestingModel(
  base: YProsemirrorDocumentModel,
  view: View,
  author: Author | null,
): YProsemirrorDocumentModel {
  const schema = base.schema;
  /** Per block, the change the text a write cut from its end belongs to: a block inserted right after joins it. */
  const tails = new Map<Y.XmlElement, SuggestionAttrs>();
  const stored = (block: BlockRef) => storedNode(unwrapBlock(block), schema);
  const shown = (block: BlockRef) => viewBlock(stored(block), view);
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
      return base.projectBlocks(doc).flatMap((projected) => {
        const node = viewBlock(projected.node, view);
        return node ? [{ ...projected, node }] : [];
      });
    },

    textblockLineage(block, path, from, to) {
      if (path.length > 0) return base.textblockLineage(block, path, from, to);
      const units = runs(stored(block), view);
      return base.textblockLineage(
        block,
        path,
        rawUnit(units, from, "start"),
        rawUnit(units, to, "end"),
      );
    },

    applyOps(doc, block, ops) {
      const before = stored(block);
      // Nothing in the block that the view hides or marks: view units are stored units.
      if (view.draft === null && viewBlock(before, view) === before) {
        return base.applyOps(doc, block, ops);
      }
      const authors = authorsOf(block);
      const out = rewritten(before, ops, view, author, authors, schema);
      if (typeof out === "string") return refused(out);
      const applied = applyRawOps(unwrapBlock(block), lowerBlock(before, out.node));
      if (applied.ok) recordStarted(out.tr, authors);
      if (out.endChange) tails.set(unwrapBlock(block), out.endChange);
      return applied;
    },

    insertBlocks(doc, after, parsed) {
      if (view.draft === null || !author) return base.insertBlocks(doc, after, parsed);
      let sug = after && tails.get(unwrapBlock(after));
      if (!sug) {
        sug = { id: newChangeId(), draft: view.draft };
        suggestionAuthors(unwrapDoc(doc)).set(sug.id, author);
      }
      if (after) tails.delete(unwrapBlock(after));
      return base.insertBlocks(doc, after, {
        ...parsed,
        blocks: parsed.blocks.map((node) => suggested(node, sug)),
      });
    },

    deleteBlock(doc, block) {
      const node = stored(block);
      if (view.draft === null || !author) {
        base.deleteBlock(doc, block);
        return;
      }
      // A block after it lets the delete take the whole block, which then stays as its removal.
      const rest = schema.nodes.paragraph.create();
      const state = EditorState.create({
        schema,
        doc: schema.topNodeType.create(null, [node, rest]),
      });
      const authors = authorsOf(block);
      const out = rewrite(state.tr.delete(0, node.nodeSize), state, view, author, authors);
      // The view's own block this turn wrote is no suggestion to keep: it goes.
      if (out.doc.childCount === 1) {
        base.deleteBlock(doc, block);
        return;
      }
      const after = out.doc.firstChild as PMNode;
      applyRawOps(unwrapBlock(block), lowerBlock(node, after));
      recordStarted(out, authors);
    },
  };

  function authorsOf(block: BlockRef): Authors {
    return suggestionAuthors(unwrapBlock(block).doc as Y.Doc);
  }

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
  authors: Authors,
  schema: Schema,
): { node: PMNode; endChange: SuggestionAttrs | null; tr: Transaction } | string {
  const state = EditorState.create({ schema, doc: schema.topNodeType.create(null, node) });
  const tr = state.tr;
  const map = (pos: number, assoc = 1) => tr.mapping.map(pos, assoc);
  let endAt: number | null = null;
  for (const op of ops) {
    const target = locate(state.doc, op.path, view);
    if (!target) return "the write does not fit the block";
    if (op.kind === "delete") {
      tr.delete(map(target.pos, 1), map(target.pos + target.node.nodeSize, -1));
    } else if (op.kind === "insert") {
      tr.insert(map(childEnd(target, op.after, view), -1), [...op.nodes]);
    } else if (op.kind === "attrs") {
      const at =
        op.unit === undefined
          ? target.pos
          : target.pos + 1 + rawUnit(runs(target.node, view), op.unit, "start");
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
        if (content.size > 0) tr.replaceWith(a, b, content);
        else if (b > a) tr.delete(a, b);
        if (op.path.length === 0 && from < to && to === end)
          endAt = start + rawUnit(units, to, "end");
      }
    }
  }
  const out = rewrite(tr, state, view, author, authors);
  if (out.getMeta(DROPPED_META)) return "part of the write cannot be suggested here";
  if (out.doc.childCount !== 1) return "the write does not fit the block";
  const changes = (out.getMeta(CHANGE_META) as ChangeAt[] | undefined) ?? [];
  return {
    node: out.doc.child(0),
    tr: out,
    endChange: changes.find((at) => at.from < at.to && at.to === endAt)?.change ?? null,
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

/** A stored block, suggestions and all: the model reads it many times per write. */
function storedNode(element: Y.XmlElement, schema: Schema): PMNode {
  const node = heldBlocks(element.doc as Y.Doc, schema, "projectBlocks").of(element);
  if (!node) throw new Error("The schema cannot build a block of the document");
  return node;
}
