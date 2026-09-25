/** Resolves stable editor anchors across document changes. */

import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import {
  relativePositionForIndex,
  relativePositionRuntimeFromState,
  resolveRelativeRange,
} from "./relative-position-runtime";

export type AnchorRange = { from: number; to: number };

/** A range that survives what ProseMirror's own mapping cannot. */
export type EditorAnchor = AnchorRange & {
  relative: { start: Y.RelativePosition; end: Y.RelativePosition } | null;
};

/** Pin a range so a surface can find it again after the document moves. */
export function anchorRange(state: EditorState, range: AnchorRange): EditorAnchor {
  const runtime = relativePositionRuntimeFromState(state);
  const start = runtime && relativePositionForIndex(runtime, range.from);
  const end = runtime && relativePositionForIndex(runtime, range.to);
  return { from: range.from, to: range.to, relative: start && end ? { start, end } : null };
}

/** Carry the anchor's fallback numbers across one mapping. */
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

/** Where the anchor sits in this state, or null when it is gone. */
export function resolveAnchorIn(state: EditorState, anchor: EditorAnchor): AnchorRange | null {
  const runtime = relativePositionRuntimeFromState(state);
  if (runtime && anchor.relative) return resolveRelativeRange(runtime, anchor.relative);
  if (anchor.from < 0 || anchor.to > state.doc.content.size) return null;
  return { from: anchor.from, to: anchor.to };
}

/** Where a held range sits after a change, or null when it is gone. */
export function resolveAnchor(
  state: EditorState,
  anchor: EditorAnchor,
  mapping: Mappable,
): AnchorRange | null {
  const carried = carryAnchor(anchor, mapping);
  return carried && resolveAnchorIn(state, carried);
}

/** The same held range, re-pinned against the document as it now stands. */
export function followAnchor(
  state: EditorState,
  anchor: EditorAnchor,
  mapping: Mappable,
): EditorAnchor | null {
  const at = resolveAnchor(state, anchor, mapping);
  return at && anchorRange(state, at);
}

/** A node a surface has hold of: where it is, and WHICH node it is. */
export type NodeHold = EditorAnchor & {
  identity: Y.XmlElement | null;
  /** Read back at every resolution: coordinates outlive what was at them. */
  nodeType: string;
};

/** Take hold of the node starting at `pos`, or null when none starts there. */
export function holdNode(state: EditorState, pos: number): NodeHold | null {
  if (pos < 0 || pos > state.doc.content.size) return null;
  const $pos = state.doc.resolve(pos);
  const node = $pos.nodeAfter;
  // Text has no element of its own — a run of it is one Yjs item shared with
  // its neighbours — so a range of text is an `EditorAnchor` plus a mark's
  // attributes (`LinkAnchor`), never a hold.
  if (!node || node.isText) return null;
  return {
    ...anchorRange(state, { from: pos, to: pos + node.nodeSize }),
    identity: yElementAt(state, $pos),
    nodeType: node.type.name,
  };
}

/** Where the held node is now, or null once it is not that node any more. */
export function resolveNodeHold(state: EditorState, hold: NodeHold): AnchorRange | null {
  const at = resolveAnchorIn(state, hold);
  // Both seams on one point is a node that went away, which is all the answer
  // there is without a shared document behind the hold.
  if (!at || at.from >= at.to) return null;
  const $pos = state.doc.resolve(at.from);
  const node = $pos.nodeAfter;
  if (!node || node.type.name !== hold.nodeType) return null;
  if (yElementAt(state, $pos) !== hold.identity) return null;
  // The node's own size, not the far seam: a peer typing INSIDE it moves that
  // seam, and a verb acts on the node as it now stands.
  return { from: at.from, to: at.from + node.nodeSize };
}

/** The same node after a change, re-pinned. Null once it is not the same node. */
export function followNode(state: EditorState, hold: NodeHold, mapping: Mappable): NodeHold | null {
  return followHold(state, hold, mapping, resolveNodeHold);
}

/**
 * Take hold of the top-level block starting at `pos`, or null when `pos` is not
 * the start of one.
 */
export function holdBlock(state: EditorState, pos: number): NodeHold | null {
  if (pos < 0 || pos > state.doc.content.size) return null;
  return state.doc.resolve(pos).depth === 0 ? holdNode(state, pos) : null;
}

/** Where the held block is now, or null when the writer's block is gone. */
export function resolveBlockHold(state: EditorState, hold: NodeHold): AnchorRange | null {
  const at = resolveNodeHold(state, hold);
  // A peer who wrapped the block in something else left it somewhere no block
  // surface can act on.
  return at && state.doc.resolve(at.from).depth === 0 ? at : null;
}

/** The same block after a change, re-pinned. Null once it is not the same block. */
export function followBlock(
  state: EditorState,
  hold: NodeHold,
  mapping: Mappable,
): NodeHold | null {
  return followHold(state, hold, mapping, resolveBlockHold);
}

/** Two holds on the same node in the same place. */
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

/** The Yjs element behind the node after `$pos`, at any depth. */
function yElementAt(state: EditorState, $pos: ResolvedPos): Y.XmlElement | null {
  const runtime = relativePositionRuntimeFromState(state);
  if (!runtime) return null;

  let current: Y.XmlFragment = runtime.yFragment;
  for (let depth = 0; depth <= $pos.depth; depth += 1) {
    const parent = $pos.node(depth);
    const child = parent.child($pos.index(depth));
    const index = yChildIndex(parent, $pos.index(depth));
    if (index === null || index >= current.length) return null;

    const yChild = current.get(index);
    // A name that does not match means the two trees are not walking in step —
    // a node the binding refused to build, a repair mid-flight. Answering null
    // lets the holder release rather than aim a verb by a guess.
    if (!(yChild instanceof Y.XmlElement) || yChild.nodeName !== child.type.name) return null;
    current = yChild;
  }
  return current instanceof Y.XmlElement ? current : null;
}

/** Where `parent`'s `index`-th child sits among the Yjs element's children. */
function yChildIndex(parent: PMNode, index: number): number | null {
  if (index < 0 || index >= parent.childCount || parent.child(index).isText) return null;

  let yIndex = 0;
  let inTextRun = false;
  for (let before = 0; before < index; before += 1) {
    const text = parent.child(before).isText;
    if (!text || !inTextRun) yIndex += 1;
    inTextRun = text;
  }
  return yIndex;
}

/** True when this transaction is the binding rebuilding the document from Yjs — a peer's write or an AI write arriving, rather than anything done here. */
export function isRemoteDocumentRebuild(transaction: Transaction): boolean {
  const meta = transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return meta?.isChangeOrigin === true;
}
