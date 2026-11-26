/**
 * A position in a textblock as a Loro cursor in the block's text doc (the binding's `DocCursor`):
 * the one way the editor holds a place across anyone's edits (anchors and holds, reading position,
 * peers' carets). A cursor holds a character, so a caret after text holds the unit before it
 * (`after`), and text a peer types at the caret lands after it.
 */
import type { RoomDocs } from "@meridian/document-model";
import { cursorAt, type DocCursor, loroSyncKey } from "@meridian/loro-prosemirror";
import type { Node } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

export function docsOf(state: EditorState): RoomDocs | null {
  const docs = loroSyncKey.getState(state)?.docs;
  return docs && !docs.isFreed ? docs : null;
}

export function pointAt(docs: RoomDocs, doc: Node, pos: number): DocCursor | null {
  if (pos < 0 || pos > doc.content.size) return null;
  return cursorAt(docs, doc.resolve(pos));
}

export function findBlock(doc: Node, id: string): { node: Node; pos: number } | null {
  let found: { node: Node; pos: number } | null = null;
  doc.descendants((child, pos) => {
    if (found) return false;
    if (child.attrs.id === id) {
      found = { node: child, pos };
      return false;
    }
    return !child.isTextblock;
  });
  return found;
}

export type EncodedPoint = { block: string; cursor: string; after: boolean };

export function encodePoint(point: DocCursor): EncodedPoint {
  let binary = "";
  for (const byte of point.cursor) binary += String.fromCharCode(byte);
  return { block: point.block, cursor: btoa(binary), after: point.after };
}

export function decodePoint(value: unknown): DocCursor | null {
  if (typeof value !== "object" || value === null) return null;
  const { block, cursor, after } = value as Record<string, unknown>;
  if (typeof block !== "string" || typeof cursor !== "string") return null;
  try {
    return {
      block,
      cursor: Uint8Array.from(atob(cursor), (c) => c.charCodeAt(0)),
      after: after === true,
    };
  } catch {
    return null;
  }
}
