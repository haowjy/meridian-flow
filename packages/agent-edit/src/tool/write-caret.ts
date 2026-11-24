import {
  type DocKey,
  type DocVersion,
  inText,
  type RoomDocs,
  type RoomVersion,
  scoped,
  shownUnits,
  withVector,
} from "@meridian/document-model";
import type { DocCursor } from "@meridian/loro-prosemirror";
import { resolveCursor } from "@meridian/loro-prosemirror";
import type { PMNode } from "@meridian/markup";
import type { Frontiers, LoroDoc } from "loro-crdt";
import type { TextEnd } from "../ports/model.js";

/**
 * Where a write ended, for the agent's caret, as a cursor in a block's text doc (the binding's
 * `DocCursor`), so it holds its place while others type: just after its last text change, in
 * document order. A write that changed no text (it removed, moved or restyled blocks) puts it
 * beside the last block it touched; null when no block is left to hold it, which clears the caret.
 *
 * `planned` names the semantic end on the planning copy; this function resolves it after the
 * batch has merged into `docs`, then re-encodes the point there. The diff is the fallback for
 * inserted blocks and structural writes. Walks every block of `before` and `after`.
 */
export function writeCaret(
  docs: RoomDocs,
  since: RoomVersion,
  written: readonly DocKey[],
  planned: DocCursor | null,
  before: readonly PMNode[],
  after: readonly PMNode[],
): DocCursor | null {
  if (planned) {
    const doc = documentOf(after);
    const position = resolveCursor(docs, doc, planned);
    if (position !== null) return cursorAfterPosition(docs, doc, position);
  }
  const blocks = textblocks(after);
  const keys = new Set(written);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i].attrs.id as string;
    const doc = keys.has(block) ? docs.textOf(block) : undefined;
    const end = doc && lastChange(doc, since.get(block));
    if (doc && end !== undefined && end !== null) return cursorIn(doc, block, end);
  }
  return besideStructure(docs, textblocks(before), blocks);
}

/**
 * The semantic end of the last text operation, encoded on the planning copy that performed it.
 * The saved-room copy later resolves and re-encodes this point after importing the write.
 */
export function plannedWriteCaret(
  docs: RoomDocs,
  ends: readonly TextEnd[],
  blocks: readonly PMNode[],
): DocCursor | null {
  if (ends.length === 0) return null;
  const offsets = new Map<string, number>();
  for (const { block, offset } of ends)
    offsets.set(block, Math.max(offsets.get(block) ?? 0, offset));
  const doc = documentOf(blocks);
  let targetStart: number | undefined;
  let targetOffset = 0;
  doc.descendants((node, pos) => {
    const offset = typeof node.attrs.id === "string" ? offsets.get(node.attrs.id) : undefined;
    if (node.isTextblock && offset !== undefined) {
      targetStart = pos + 1;
      targetOffset = Math.min(offset, node.content.size);
    }
    return !node.isTextblock;
  });
  return targetStart === undefined
    ? null
    : cursorAfterPosition(docs, doc, targetStart + targetOffset);
}

/** The end of the last textblock in the last top-level block this command wrote. */
export function plannedBlockCaret(
  docs: RoomDocs,
  written: ReadonlySet<string>,
  blocks: readonly PMNode[],
): DocCursor | null {
  if (written.size === 0) return null;
  const doc = documentOf(blocks);
  let target: number | undefined;
  doc.forEach((top, topOffset) => {
    if (!written.has(top.attrs.id as string)) return;
    if (top.isTextblock) target = topOffset + 1 + top.content.size;
    top.descendants((node, pos) => {
      if (node.isTextblock) target = topOffset + pos + 2 + node.content.size;
      return !node.isTextblock;
    });
  });
  return target === undefined ? null : cursorAfterPosition(docs, doc, target);
}

/** The resolver's exact splice endpoint, encoded on the document where its edit was applied. */
export function plannedResolvedCaret(
  docs: RoomDocs,
  caret: { block: number; offset: number },
  ends: readonly TextEnd[],
  blocks: readonly PMNode[],
): DocCursor | null {
  const top = blocks[caret.block];
  if (!top) return null;
  const doc = documentOf(blocks);
  let topOffset = 0;
  for (let index = 0; index < caret.block; index++) topOffset += blocks[index].nodeSize;
  const starts: { id: string; node: PMNode; start: number; consumed: number }[] = [];
  let consumed = 0;
  const remember = (node: PMNode, start: number) => {
    if (!node.isTextblock || typeof node.attrs.id !== "string") return;
    starts.push({ id: node.attrs.id, node, start, consumed });
    consumed += node.textContent.length;
  };
  remember(top, topOffset + 1);
  top.descendants((node, pos) => {
    remember(node, topOffset + pos + 2);
    return !node.isTextblock;
  });
  const candidates = starts
    .map((target) => ({ target, local: caret.offset - target.consumed }))
    .filter(({ target, local }) => local >= 0 && local <= target.node.textContent.length);
  const applied = ends
    .toReversed()
    .find((end) => candidates.some(({ target }) => target.id === end.block));
  const chosen =
    candidates.length === 1
      ? candidates[0]
      : candidates.find(({ target }) => target.id === applied?.block);
  if (!chosen) return null;
  const pmOffset = textOffset(chosen.target.node, chosen.local);
  if (pmOffset !== null) return cursorAfterPosition(docs, doc, chosen.target.start + pmOffset);
  if (!applied || chosen.target.id !== applied.block) return null;
  return cursorAfterPosition(
    docs,
    doc,
    chosen.target.start + Math.min(applied.offset, chosen.target.node.content.size),
  );
}

/** A text offset's ProseMirror offset, or null when a textless inline node makes it ambiguous. */
function textOffset(block: PMNode, wanted: number): number | null {
  let text = 0;
  let pm = 0;
  const candidates = new Set<number>();
  for (let index = 0; index < block.childCount; index++) {
    const child = block.child(index);
    if (child.isText) {
      const size = child.text?.length ?? 0;
      if (wanted >= text && wanted <= text + size) candidates.add(pm + wanted - text);
      text += size;
    } else if (wanted === text) {
      candidates.add(pm);
      candidates.add(pm + child.nodeSize);
    }
    pm += child.nodeSize;
  }
  if (wanted === text) candidates.add(pm);
  return candidates.size === 1 ? [...candidates][0] : null;
}

function documentOf(blocks: readonly PMNode[]): PMNode {
  const schema = blocks[0]?.type.schema;
  if (!schema) throw new Error("Cannot make a caret in an empty document");
  return schema.topNodeType.create(null, [...blocks]);
}

/** A cursor held by the shown unit immediately before `position`, so later text stays after it. */
function cursorAfterPosition(docs: RoomDocs, doc: PMNode, position: number): DocCursor | null {
  const $position = doc.resolve(position);
  const block = $position.parent;
  const id = block.attrs.id;
  const textDoc = typeof id === "string" && block.isTextblock ? docs.textOf(id) : undefined;
  const rule = textDoc && docs.shape.node(block.type.name);
  if (!textDoc || !rule) return null;
  const units = shownUnits(textDoc, rule, docs.shape);
  const offset = $position.parentOffset;
  const unit = offset > 0 ? units[Math.min(offset, units.length) - 1] : units[0];
  if (!unit) return null;
  const cursor = inText(textDoc, (text) => {
    const made = text.getCursor(unit.pos);
    return made && scoped(made, (held) => held.encode());
  });
  return cursor ? { block: id, cursor, after: offset > 0 } : null;
}

/** The textblocks of `blocks`, in document order. */
function textblocks(blocks: readonly PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  const visit = (node: PMNode) => {
    if (node.isTextblock && typeof node.attrs.id === "string") out.push(node);
  };
  for (const node of blocks) {
    visit(node);
    node.descendants((child) => {
      visit(child);
      return !child.isTextblock;
    });
  }
  return out;
}

/** The UTF-16 offset just after the last change to `doc` since `from`; null when none. */
function lastChange(doc: LoroDoc, before: DocVersion | undefined): number | null {
  const from: Frontiers = before ? withVector(before, (vector) => doc.vvToFrontiers(vector)) : [];
  let end: number | null = null;
  for (const [, diff] of doc.diff(from, doc.frontiers())) {
    if (diff.type !== "text") continue;
    // A text diff counts UTF-16 units in JS, as a text's positions do.
    let at = 0;
    for (const op of diff.diff) {
      if (op.insert !== undefined) {
        at += op.insert.length;
        end = at;
      } else if (op.retain !== undefined) {
        at += op.retain;
        if (op.attributes) end = at;
      } else end = at;
    }
  }
  return end;
}

/**
 * Beside the blocks a write changed without changing their text: after the last block of the
 * stretch where `after` differs from `before` (a block moved or restyled there), else after the
 * block before what it removed, else at the start of the first block left.
 */
function besideStructure(
  docs: RoomDocs,
  before: readonly PMNode[],
  after: readonly PMNode[],
): DocCursor | null {
  const same = (a: PMNode, b: PMNode) => a.attrs.id === b.attrs.id && a.eq(b);
  let head = 0;
  while (head < before.length && head < after.length && same(before[head], after[head])) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    same(before[before.length - 1 - tail], after[after.length - 1 - tail])
  )
    tail++;
  if (head + tail === before.length && head + tail === after.length) return null;
  const last = after.length - tail - 1;
  const at =
    last >= 0 ? { node: after[last], end: true } : after[0] && { node: after[0], end: false };
  if (!at) return null;
  const block = at.node.attrs.id as string;
  const doc = docs.textOf(block);
  if (!doc) return null;
  return cursorIn(doc, block, at.end ? inText(doc, (text) => text.length) : 0);
}

/** A caret at UTF-16 offset `units` of `doc`, block `block`'s text. */
function cursorIn(doc: LoroDoc, block: string, units: number): DocCursor | null {
  const cursor = inText(doc, (text) => {
    const made = text.getCursor(units > 0 ? units - 1 : 0);
    return made && scoped(made, (held) => held.encode());
  });
  return cursor ? { block, cursor, after: units > 0 } : null;
}
