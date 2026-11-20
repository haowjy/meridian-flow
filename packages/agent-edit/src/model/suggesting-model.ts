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
import { markNameOfYjsKey } from "@meridian/prosemirror-schema";
import {
  type Author,
  blockKind,
  kindOf,
  type MarkLike,
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
import * as Y from "yjs";
import type { BlockRef } from "../handles.js";
import { unwrapBlock, unwrapDoc } from "../handles.js";
import { getTopLevelXmlBlocks } from "./block-hash.js";
import { readRepairedRoot } from "./schema-repair.js";
import type { EditOp, EditOpsResult } from "../ports/model.js";
import { lowerBlock } from "../resolver/lower-block.js";
import { type YProsemirrorDocumentModel, applyOps as applyRawOps } from "./y-prosemirror.js";

/** `viewOf` reads the view from the document itself: which Works' drafts it has discarded. */
export function suggestingModel(
  base: YProsemirrorDocumentModel,
  viewOf: (doc: Y.Doc) => View,
  author: Author | null,
): YProsemirrorDocumentModel {
  const schema = base.schema;
  const viewAt = (block: BlockRef) => viewOf(unwrapBlock(block).doc as Y.Doc);
  const shown = (block: BlockRef) => yBlockShown(unwrapBlock(block), viewAt(block));
  return {
    ...base,

    getBlocks: (doc) => base.getBlocks(doc).filter(shown),

    getDocumentBlockIds(doc) {
      const blocks = base.getBlocks(doc);
      const ids = base.getDocumentBlockIds(doc);
      return ids.filter((_, index) => shown(blocks[index]));
    },

    getText: (block) => yVisibleText(unwrapBlock(block), viewAt(block)),

    projectBlocks(doc) {
      const view = viewOf(unwrapDoc(doc));
      return base.projectBlocks(doc).flatMap((projected) => {
        const node = viewBlock(projected.node, view);
        return node ? [{ ...projected, node }] : [];
      });
    },

    textblockLineage(block, path, from, to) {
      if (path.length > 0) return base.textblockLineage(block, path, from, to);
      const node = storedNode(block, schema);
      const units = runs(node, viewAt(block));
      return base.textblockLineage(block, path, rawUnit(units, from, "start"), rawUnit(units, to, "end"));
    },

    applyOps(doc, block, ops) {
      const view = viewAt(block);
      const before = storedNode(block, schema);
      if (view.work !== null && blockKind(before, view) !== "own" && ops.some((op) => op.kind !== "text" || op.path.length > 0))
        return refused("a suggestion changes text in a paragraph; this prototype makes no other kind");
      if (ops.some((op) => op.kind === "text" && op.formats.length > 0))
        return refused("formatting is not suggested in this prototype");
      const textOps = ops.filter((op): op is Extract<EditOp, { kind: "text" }> => op.kind === "text" && op.path.length === 0);
      const other = ops.filter((op) => !textOps.includes(op as Extract<EditOp, { kind: "text" }>));
      if (other.length > 0) {
        const applied = base.applyOps(doc, block, other);
        if (!applied.ok || textOps.length === 0) return applied;
      }
      if (textOps.length === 0) return { ok: true };
      const after = rewritten(storedNode(block, schema), textOps, view, author, schema);
      if (!after) return refused("the write does not fit the block");
      return applyRawOps(unwrapBlock(block), lowerBlock(storedNode(block, schema), after));
    },

    insertBlocks(doc, after, parsed) {
      const view = viewOf(unwrapDoc(doc));
      if (view.work === null || !author) return base.insertBlocks(doc, after, parsed);
      const sug = { ...author, work: view.work, id: newChangeId() };
      return base.insertBlocks(doc, after, {
        ...parsed,
        blocks: parsed.blocks.map((node) => node.type.create({ ...node.attrs, sug }, node.content, node.marks)),
      });
    },

    deleteBlock(doc, block) {
      const view = viewAt(block);
      const node = storedNode(block, schema);
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
    if (unit < seen + length || (unit === seen + length && side === "end")) return run.from + (unit - seen);
    seen += length;
    lastEnd = run.to;
  }
  return lastEnd;
}

/** A top-level block as stored, suggestions and all. Reads the whole fragment: fine for a prototype. */
function storedNode(block: BlockRef, schema: Schema): PMNode {
  const element = unwrapBlock(block);
  const fragment = element.parent as Y.XmlFragment;
  const index = getTopLevelXmlBlocks(element.doc as Y.Doc).indexOf(element);
  return readRepairedRoot("projectBlocks", fragment, schema).child(index);
}

/** The table, read straight from Yjs: a text's attributes are its marks, keyed as stored. */
function yMarks(attributes: Record<string, unknown> | undefined): MarkLike[] {
  return Object.entries(attributes ?? {}).map(([key, attrs]) => ({
    type: { name: markNameOfYjsKey(key) },
    attrs: (attrs ?? {}) as Record<string, unknown>,
  }));
}

function yBlock(element: Y.XmlElement) {
  return { attrs: { sug: element.getAttribute("sug") ?? null } as Record<string, unknown> };
}

function yRuns(element: Y.XmlElement, view: View, visit: (text: string, shown: boolean, kind: string) => void): void {
  const block = yBlock(element);
  for (const child of element.toArray()) {
    if (!(child instanceof Y.XmlText)) continue;
    for (const part of child.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
      if (typeof part.insert !== "string") continue;
      const kind = kindOf(yMarks(part.attributes), block, view);
      visit(part.insert, visible(kind), kind);
    }
  }
}

function yVisibleText(element: Y.XmlElement, view: View): string {
  if (blockKind(yBlock(element), view) === "hidden") return "";
  let text = "";
  yRuns(element, view, (part, shown) => {
    if (shown) text += part;
  });
  return text;
}

/** Whether a view contains a top-level block: not another Work's, and not wholly removed by its own. */
function yBlockShown(element: Y.XmlElement, view: View): boolean {
  if (blockKind(yBlock(element), view) === "hidden") return false;
  let removed = false;
  let shown = false;
  yRuns(element, view, (_, isShown, kind) => {
    if (isShown) shown = true;
    if (kind === "own-del") removed = true;
  });
  return shown || !removed;
}
