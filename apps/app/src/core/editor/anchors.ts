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

import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";

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
export function carryAnchor(anchor: EditorAnchor, mapping: Mappable): EditorAnchor | null {
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
