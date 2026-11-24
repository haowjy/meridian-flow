import {
  type DocKey,
  type DocVersion,
  inText,
  type RoomDocs,
  type RoomVersion,
  scoped,
  withVector,
} from "@meridian/document-model";
import type { DocCursor } from "@meridian/loro-prosemirror";
import type { PMNode } from "@meridian/markup";
import type { Frontiers, LoroDoc } from "loro-crdt";

/**
 * Where a write ended, for the agent's caret, as a cursor in a block's text doc (the binding's
 * `DocCursor`), so it holds its place while others type: just after its last text change, in
 * document order. A write that changed no text (it removed, moved or restyled blocks) puts it
 * beside the last block it touched; null when no block is left to hold it, which clears the caret.
 *
 * `docs` holds the write and nothing else since `since` in the docs it wrote (`editSince`'s rule).
 * Walks every block of `before` and `after`, the whole document.
 */
export function writeCaret(
  docs: RoomDocs,
  since: RoomVersion,
  written: readonly DocKey[],
  before: readonly PMNode[],
  after: readonly PMNode[],
): DocCursor | null {
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
