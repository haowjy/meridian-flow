/**
 * Positions that survive a peer's write.
 *
 * Every remote change — a collaborator typing, an AI write landing — reaches
 * this editor as a replacement of the WHOLE document: y-prosemirror rebuilds
 * the ProseMirror doc from the Yjs type and dispatches one replace step
 * (`sync-plugin.js`, `_typeChanged`). So `mapping.map` answers with a boundary
 * for every position and `mapResult` reports `deleted` for every position,
 * whatever the change actually was. A surface holding raw numbers across one
 * is pointing at nothing, and a surface that closes on `deleted` closes on
 * every peer edit and every AI write — which this product produces constantly.
 *
 * Yjs relative positions are what survive it, and they are already how this
 * editor carries the selection, the peer marks, the live ranges, and inline
 * review. This module is that mechanism as one anchor type, so a menu aimed at
 * a block, a form mid-typing, an upload landing where it was dropped, and a
 * link's range are all the same held thing.
 *
 * Two rules a caller still owns, because no position type can answer them:
 *
 * - **Position is half the answer.** Coordinates outlive the thing that was at
 *   them, and a deleted item's anchor resolves to the seam it left behind. Read
 *   what is actually there and compare it — a mark by attributes, a node by
 *   type — or the surface acts on whatever slid into the numbers.
 * - **A rebuilt document makes new objects.** `===` fails for equal marks and
 *   nodes after a remote write; `Mark.eq` and `Node.eq` are what "the same
 *   thing" means here.
 */

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

/**
 * A range that survives what ProseMirror's own mapping cannot.
 *
 * `relative` is null on an editor with no shared document (a standalone
 * surface, a test), where the mapping is the whole story because there are no
 * remote changes to survive.
 */
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

/** Pin a single position — a seam between blocks, a caret, a drop point. */
export function anchorPosition(state: EditorState, pos: number): EditorAnchor {
  return anchorRange(state, { from: pos, to: pos });
}

/**
 * Carry the anchor's fallback numbers across one mapping.
 *
 * Null means nothing can find the range any more, which an anchor with a
 * relative position never says: the mapping's `deleted` verdict is worthless
 * against a whole-document replace, so it only decides for an anchor that has
 * nothing else to fall back on.
 */
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

/**
 * Where the anchor sits in this state, or null when it is gone.
 *
 * Read against a settled state — an editor's `state` in a transaction handler,
 * a plugin's `props`. The Yjs binding is authoritative when there is one; the
 * numbers answer only for an editor with no shared document.
 */
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

/**
 * The same held range, re-pinned against the document as it now stands.
 *
 * What a surface that outlives a keystroke holds: an anchor pinned once and
 * never re-pinned still resolves, but re-pinning keeps its fallback numbers
 * honest for an editor that has no shared document at all.
 */
export function followAnchor(
  state: EditorState,
  anchor: EditorAnchor,
  mapping: Mappable,
): EditorAnchor | null {
  const at = resolveAnchor(state, anchor, mapping);
  return at && anchorRange(state, at);
}

/**
 * A node a surface has hold of: where it is, and WHICH node it is.
 *
 * The shape every long-lived surface in this editor holds its target as — an
 * open menu, a lightbox, a grip's cell, the block under a drag. DOM elements
 * are the other candidate and they are not this: a node view is replaced by
 * every remote write, so an element is excellent geometry for one frame and
 * says nothing about which content it was showing.
 *
 * Two seam positions cannot answer the second question either. A peer who
 * deletes the document's only heading leaves the schema to supply an empty
 * paragraph in its place, and the seams then describe that replacement
 * perfectly: they resolve to its boundaries, uncollapsed, and a menu opened on
 * the heading would go on offering Delete for a block the writer never saw.
 *
 * The Yjs element behind the node IS the identity. It is the same object for as
 * long as the node lives — a writer typing into it, a peer typing into it, an
 * AI write landing in it all mutate it in place — and Yjs replaces it for
 * anything that is really a new node, including a move, which is the honest
 * answer for a hold: the block a gesture grabbed is not the one that landed.
 *
 * The element rather than its item id (`getBlockItemId`, what trail navigation
 * and search passages carry) because those anchors cross a boundary and have to
 * be serializable, while a hold lives inside one session — and reading an id
 * throws for a deleted element, in a code path that runs inside Yjs update
 * handlers where a throw is swallowed and peer writes quietly stop applying.
 *
 * `identity` is null on an editor with no shared document, where the collapse
 * of the two seams and the type read back at the position are the only deletion
 * signals there are (and sound ones: with no Yjs there are no whole-document
 * rebuilds to blind the mapping).
 */
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

/**
 * Two holds on the same node in the same place.
 *
 * What lets a surface re-pin its hold on every transaction without handing
 * React a new object per keystroke: re-pinning a node nothing moved produces an
 * equal hold, and an equal hold is the one already held.
 */
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

/**
 * The Yjs element behind the node after `$pos`, at any depth.
 *
 * A Yjs element's children and its ProseMirror node's are the same list in the
 * same order, which is what makes indices enough to cross between the two trees
 * — with one adjustment: a run of adjacent text nodes is ONE `Y.XmlText` child
 * (`normalizePNodeContent`), so a child's index in the document is not its
 * index in Yjs.
 */
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

/**
 * True when this transaction is the binding rebuilding the document from Yjs —
 * a peer's write or an AI write arriving, rather than anything done here.
 *
 * The distinction matters to anything that diffs against what it last showed:
 * its base is the writer's, and a rebuild replaced the document underneath it.
 */
export function isRemoteDocumentRebuild(transaction: Transaction): boolean {
  const meta = transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return meta?.isChangeOrigin === true;
}
