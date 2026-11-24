import {
  type DocKey,
  inText,
  type RoomDocs,
  type RoomVersion,
  scoped,
  withVector,
} from "@meridian/document-model";
import type { DocCursor } from "@meridian/loro-prosemirror";
import type { PMNode } from "@meridian/markup";
import type { Frontiers } from "loro-crdt";

/**
 * Where a write ended, for the agent's caret: just after its last change in the last block it
 * wrote, in document order, as a cursor in that block's text doc (the binding's `DocCursor`), so
 * it holds its place while others type. Null when the write left no text it changed (it only
 * removed blocks).
 *
 * `docs` holds the write and nothing else since `since` in the docs it wrote (`editSince`'s rule).
 */
export function writeCaret(
  docs: RoomDocs,
  since: RoomVersion,
  written: readonly DocKey[],
  blocks: readonly PMNode[],
): DocCursor | null {
  const keys = new Set(written);
  let block: string | null = null;
  const visit = (node: PMNode) => {
    const id = node.attrs.id;
    if (typeof id === "string" && keys.has(id) && node.isTextblock) block = id;
  };
  for (const node of blocks) {
    visit(node);
    node.descendants((child) => {
      visit(child);
      return !child.isTextblock;
    });
  }
  const doc = block === null ? undefined : docs.textOf(block);
  if (block === null || !doc) return null;
  const before = since.get(block);
  const from: Frontiers = before ? withVector(before, (vector) => doc.vvToFrontiers(vector)) : [];
  let end: number | null = null;
  for (const [, diff] of doc.diff(from, doc.frontiers())) {
    if (diff.type !== "text") continue;
    let at = 0;
    for (const op of diff.diff) {
      if (op.insert !== undefined) {
        at += [...op.insert].length;
        end = at;
      } else if (op.retain !== undefined) {
        at += op.retain;
        if (op.attributes) end = at;
      } else end = at;
    }
  }
  if (end === null) return null;
  // The diff counts code points; a text's positions are UTF-16 units.
  const text = inText(doc, (each) => each.toString());
  const units = [...text].slice(0, end).join("").length;
  const cursor = inText(doc, (each) => {
    const made = each.getCursor(units > 0 ? units - 1 : 0);
    return made && scoped(made, (held) => held.encode());
  });
  return cursor ? { block, cursor, after: units > 0 } : null;
}
