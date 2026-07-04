/**
 * Inline review model — the client-side view of the server's draft review hunk
 * model. Pure data types plus the anchor-decode helper that converts the
 * server's base64-encoded `Y.RelativePosition` strings back into runtime
 * `RelativePosition` instances the plugin can resolve against the live
 * y-prosemirror binding.
 *
 * Kept free of ProseMirror imports so it can be unit-tested without a DOM.
 */
import type { ReviewBlockDisplay, ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import * as Y from "yjs";

export type InlineReviewOperationKind = "agent" | "writer";

/**
 * A per-operation piece of an inserted hunk. Every inserted character is
 * covered by exactly one span, so nested authorship (e.g. a writer edit
 * inside an AI insertion) is expressed as adjacent spans that render in
 * their owner's color. The union of a hunk's spans equals its full
 * insertion range.
 */
export interface ResolvedReviewSpan {
  operationId: string;
  from: Y.RelativePosition;
  to: Y.RelativePosition;
}

/** Anchor pair shared by both hunk kinds, decoded to runtime `Y.RelativePosition`. */
interface ResolvedReviewHunkBase {
  hunkId: string;
  operationIds: string[];
  /** Resolves to the start of the insertion / caret for a pure deletion. */
  relStart: Y.RelativePosition;
  /** Resolves to the end of the insertion; equal to `relStart` for pure deletions. */
  relEnd: Y.RelativePosition;
}

/** Word-diff hunk inside a paragraph/heading — inline spans + deletion widget. */
export interface ResolvedTextReviewHunk extends ResolvedReviewHunkBase {
  kind: "text";
  /**
   * Per-operation ordered, non-overlapping slices of this hunk's insertion
   * range. Empty for pure deletions. The plugin renders one decoration per
   * span (colored by its owning operation's kind) instead of a single
   * whole-hunk decoration — this is what lets writer edits colored gold
   * appear inside a green AI insertion.
   */
  spans: ResolvedReviewSpan[];
  /** Present when the hunk shows text removed from live but absent in draft. */
  deletedText?: string;
}

/**
 * Whole-block replace hunk for non-paragraph/heading blocks (lists, rules,
 * quotes, images). The anchor spans the inserted draft block, or collapses to
 * a zero-width caret at the delete site. Display payloads carry the server's
 * one-line rendering of each side so atom blocks (a horizontal rule, an
 * image) stay representable even though they have no text.
 */
export interface ResolvedBlockReviewHunk extends ResolvedReviewHunkBase {
  kind: "block";
  insertedBlock?: ReviewBlockDisplay;
  deletedBlock?: ReviewBlockDisplay;
}

/** A hunk with anchors already decoded to runtime `Y.RelativePosition`. */
export type ResolvedReviewHunk = ResolvedTextReviewHunk | ResolvedBlockReviewHunk;

/** The full plugin input: hunks + operations + a revision token from the server. */
export interface InlineReviewModel {
  /** Server-issued token identifying the live base the model was computed against. */
  liveRevisionToken?: number;
  /** Server-issued token identifying the draft state the model was computed against. */
  draftRevisionToken: number;
  operations: ReviewOperation[];
  hunks: ResolvedReviewHunk[];
}

/**
 * Decode a base64 `Y.RelativePosition` produced by the server draft-review
 * hunk pipeline. Returns `null` on malformed input rather than throwing —
 * the plugin degrades to skipping the hunk when an anchor won't decode.
 *
 * A `Y.RelativePosition` addresses one of three things: `tname` (top-level
 * fragment name), `type` (a nested Y.AbstractType id), or `item` (a specific
 * CRDT item by `{client, clock}` — the common case for anchoring to a
 * character position in text). `Y.decodeRelativePosition` accepts arbitrary
 * bytes and hands back an all-null position; reject only when all three
 * addressability channels are absent.
 */
export function decodeAnchor(encoded: string): Y.RelativePosition | null {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  try {
    const bytes = base64ToBytes(encoded);
    const decoded = Y.decodeRelativePosition(bytes);
    if (decoded.type == null && decoded.tname == null && decoded.item == null) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Build an `InlineReviewModel` from a raw server response. Hunks with
 * un-decodable anchors are dropped — a stale/corrupted anchor should never
 * crash review; it just means one hunk is invisible until the next refetch.
 */
export function buildInlineReviewModel(input: {
  liveRevisionToken?: number;
  draftRevisionToken: number;
  operations: ReviewOperation[];
  hunks: ReviewHunk[];
}): InlineReviewModel {
  const resolved: ResolvedReviewHunk[] = [];
  for (const hunk of input.hunks) {
    const relStart = decodeAnchor(hunk.anchor.relStart);
    const relEnd = decodeAnchor(hunk.anchor.relEnd);
    if (!relStart || !relEnd) continue;
    const base = {
      hunkId: hunk.hunkId,
      operationIds: hunk.operationIds,
      relStart,
      relEnd,
    };
    if (hunk.kind === "block") {
      resolved.push({
        ...base,
        kind: "block",
        ...(hunk.insertedBlock ? { insertedBlock: hunk.insertedBlock } : {}),
        ...(hunk.deletedBlock ? { deletedBlock: hunk.deletedBlock } : {}),
      });
      continue;
    }
    // Spans are optional at wire-level — a text hunk with no spans falls back
    // to whole-hunk coloring by the plugin. Drop malformed span anchors
    // instead of dropping the hunk; a missing span just paints as its
    // neighbour.
    const spans: ResolvedReviewSpan[] = [];
    for (const span of hunk.spans) {
      const from = decodeAnchor(span.anchorFrom);
      const to = decodeAnchor(span.anchorTo);
      if (!from || !to) continue;
      spans.push({ operationId: span.operationId, from, to });
    }
    resolved.push({
      ...base,
      kind: "text",
      spans,
      ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
    });
  }
  return {
    ...(input.liveRevisionToken === undefined
      ? {}
      : { liveRevisionToken: input.liveRevisionToken }),
    draftRevisionToken: input.draftRevisionToken,
    operations: input.operations,
    hunks: resolved,
  };
}

/**
 * Kind of the first-listed operation for a hunk drives its highlight color.
 * When a hunk belongs to multiple operations (coalescence), agent kind wins
 * only if every contributing operation is agent — any writer contribution
 * paints the writer color so the writer instantly sees "I touched this."
 */
export function hunkKind(
  hunk: ResolvedReviewHunk,
  operationsById: ReadonlyMap<string, ReviewOperation>,
): InlineReviewOperationKind {
  let sawWriter = false;
  let sawAgent = false;
  for (const opId of hunk.operationIds) {
    const op = operationsById.get(opId);
    if (!op) continue;
    if (op.kind === "writer") sawWriter = true;
    else sawAgent = true;
  }
  if (sawWriter) return "writer";
  if (sawAgent) return "agent";
  // Fall back to agent — treats unknown attribution as AI to preserve the
  // "green = something changed here" reading rather than showing nothing.
  return "agent";
}

/** Index operations by id for O(1) lookup by the plugin. */
export function indexOperations(
  operations: readonly ReviewOperation[],
): Map<string, ReviewOperation> {
  const map = new Map<string, ReviewOperation>();
  for (const op of operations) map.set(op.operationId, op);
  return map;
}

function base64ToBytes(input: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(input);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  // Node fallback for unit tests / SSR paths.
  return new Uint8Array(Buffer.from(input, "base64"));
}
