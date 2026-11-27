import {
  type DocCursor,
  loroSyncKey,
  REMOTE_META,
  resolveCursor,
} from "@meridian/loro-prosemirror";
import type { ResolvedPos } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { docsOf, findBlock, pointAt } from "./loro-points";

export type AnchorRange = { from: number; to: number };

export type EditorAnchor = AnchorRange & {
  relative: { start: DocCursor; end: DocCursor } | null;
};

export function anchorRange(state: EditorState, range: AnchorRange): EditorAnchor {
  const docs = docsOf(state);
  const start = docs && pointAt(docs, state.doc, range.from);
  const end = docs && pointAt(docs, state.doc, range.to);
  const relative = start && end ? { start, end } : null;
  const held = relative && resolveRelative(state, relative);
  const faithful = held?.from === range.from && held.to === range.to;
  return { from: range.from, to: range.to, relative: faithful ? relative : null };
}

function resolveRelative(
  state: EditorState,
  relative: { start: DocCursor; end: DocCursor },
): AnchorRange | null {
  const docs = docsOf(state);
  if (!docs) return null;
  const from = resolveCursor(docs, state.doc, relative.start);
  const to = resolveCursor(docs, state.doc, relative.end);
  if (from === null || to === null || to < from) return null;
  return { from, to };
}

export function carryAnchor<Anchor extends EditorAnchor>(
  anchor: Anchor,
  mapping: Mappable,
): Anchor | null {
  // An empty range is a caret, and both of its edges are the same edge: text a
  // peer types there belongs to the document, so the caret stays in front of
  // it. Biasing them apart would invert the range, and a commit against an
  // inverted range writes somewhere nobody asked for.
  if (anchor.from === anchor.to) {
    const at = mapping.mapResult(anchor.from, -1);
    if (at.deleted && !anchor.relative) return null;
    return { ...anchor, from: at.pos, to: at.pos };
  }

  const from = mapping.mapResult(anchor.from, 1);
  const to = mapping.mapResult(anchor.to, -1);
  if ((from.deleted || to.deleted || to.pos < from.pos) && !anchor.relative) return null;
  return { ...anchor, from: from.pos, to: Math.max(from.pos, to.pos) };
}

export function resolveAnchorIn(state: EditorState, anchor: EditorAnchor): AnchorRange | null {
  if (anchor.relative && docsOf(state)) return resolveRelative(state, anchor.relative);
  if (anchor.from < 0 || anchor.to > state.doc.content.size) return null;
  return { from: anchor.from, to: anchor.to };
}

export function resolveAnchor(
  state: EditorState,
  anchor: EditorAnchor,
  mapping: Mappable,
): AnchorRange | null {
  const carried = carryAnchor(anchor, mapping);
  return carried && resolveAnchorIn(state, carried);
}

export function followAnchor(
  state: EditorState,
  anchor: EditorAnchor,
  mapping: Mappable,
): EditorAnchor | null {
  const at = resolveAnchor(state, anchor, mapping);
  return at && anchorRange(state, at);
}

export type NodeHold = EditorAnchor & {
  identity: string | null;
  nodeType: string;
};

export function holdNode(state: EditorState, pos: number): NodeHold | null {
  if (pos < 0 || pos > state.doc.content.size) return null;
  const $pos = state.doc.resolve(pos);
  const node = $pos.nodeAfter;
  if (!node || node.isText) return null;
  return {
    ...anchorRange(state, { from: pos, to: pos + node.nodeSize }),
    identity: identityAt($pos),
    nodeType: node.type.name,
  };
}

export function resolveNodeHold(state: EditorState, hold: NodeHold): AnchorRange | null {
  if (hold.identity !== null) {
    const found = findBlock(state.doc, hold.identity);
    return found && found.node.type.name === hold.nodeType
      ? { from: found.pos, to: found.pos + found.node.nodeSize }
      : null;
  }
  const at = resolveAnchorIn(state, hold);
  if (!at || at.from >= at.to) return null;
  const $pos = state.doc.resolve(at.from);
  const node = $pos.nodeAfter;
  if (!node || node.type.name !== hold.nodeType || identityAt($pos) !== null) return null;
  // The node's own size, not the far seam: a peer typing INSIDE it moves that
  // seam, and a verb acts on the node as it now stands.
  return { from: at.from, to: at.from + node.nodeSize };
}

export function followNode(state: EditorState, hold: NodeHold, mapping: Mappable): NodeHold | null {
  return followHold(state, hold, mapping, resolveNodeHold);
}

export function holdBlock(state: EditorState, pos: number): NodeHold | null {
  if (pos < 0 || pos > state.doc.content.size) return null;
  return state.doc.resolve(pos).depth === 0 ? holdNode(state, pos) : null;
}

export function resolveBlockHold(state: EditorState, hold: NodeHold): AnchorRange | null {
  const at = resolveNodeHold(state, hold);
  return at && state.doc.resolve(at.from).depth === 0 ? at : null;
}

export function followBlock(
  state: EditorState,
  hold: NodeHold,
  mapping: Mappable,
): NodeHold | null {
  return followHold(state, hold, mapping, resolveBlockHold);
}

export function sameHold(one: NodeHold | null, other: NodeHold | null): boolean {
  if (one === other) return true;
  if (!one || !other) return false;
  return (
    one.from === other.from &&
    one.to === other.to &&
    one.identity === other.identity &&
    one.nodeType === other.nodeType
  );
}

function followHold(
  state: EditorState,
  hold: NodeHold,
  mapping: Mappable,
  resolve: (state: EditorState, hold: NodeHold) => AnchorRange | null,
): NodeHold | null {
  const carried = carryAnchor(hold, mapping);
  const at = carried && resolve(state, carried);
  return at && { ...anchorRange(state, at), identity: hold.identity, nodeType: hold.nodeType };
}

function identityAt($pos: ResolvedPos): string | null {
  const id = $pos.nodeAfter?.attrs.id;
  return typeof id === "string" ? id : null;
}

export function isRemoteDocumentRebuild(transaction: Transaction): boolean {
  return transaction.getMeta(loroSyncKey) === REMOTE_META;
}
